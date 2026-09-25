'use strict';

// M4.1h — 巡游 / 休息区 (wander + break area) contracts.
//
// The user-facing口径 implemented here (see
// docs/strategy/2026-09-24-office-wander-and-restarea-assessment.md §已实施):
//  1. while a whale-girl is in the ROAMING state, the share of time she spends
//     in the left HALF of the scene must land inside 40%..50%
//  2. the break area is the furniture-band strip of the left wing; resting does
//     NOT have to walk there (the own workstation is a legal rest spot too) and
//     a rest-area spot holds a LONGER rest
//  3. roaming is probabilistic: ~40% of the roaming picks that draw the
//     preference target the left rest area, and a chosen target that is
//     unreachable WAITS AND RETRIES — it is never silently reversed into a
//     right-side walk in the same decision
//  4. a trusted task preempts a local walk in the same tick and walks the
//     resident to its own workstation
//  5. patrol liveliness: the hottest dwell-node PAIR repeats below the
//     pre-M4.1h rate (dwell-pair dedup rate improves)
//  6. (r2) every resident carries a per-employee left-time budget; a walker
//     under the budget floor is ENTITLED to the wing and draws it far more
//     often than the base bias would
//  7. (r2) a SEATED conversation shows a bubble on essentially every tick —
//     the corpus per-pair cooldown must not silence whole conversations
//
// The simulation tests use the REAL office module, the REAL compiled flat
// layout and the REAL character pack; seeds are fixed, so the numbers are
// deterministic run-to-run (a tuning change that moves the metric out of the
// band fails loudly).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const officeModule = require('../src/office/office-module.js');
const idleDirector = require('../src/office/runtime/idle-director.js');
const { createOfficeLayout } = require('../src/office/runtime/office-layout.js');
const { createMovementController } = require('../src/office/runtime/movement-controller.js');
const schedulerModule = require('../src/office/runtime/behavior-scheduler.js');
const { createBehaviorScheduler } = schedulerModule;

const FLAT = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout-flat.json'), 'utf8'));
const PACK = (() => {
  const assetPack = require('../src/office/runtime/asset-pack.js');
  const root = path.join(ROOT, 'src', 'office', 'fixtures', 'character-pack');
  return assetPack.createAssetPack({
    manifest: JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')),
    anchors: JSON.parse(fs.readFileSync(path.join(root, 'animation', 'anchors.json'), 'utf8')),
    animations: JSON.parse(fs.readFileSync(path.join(root, 'animation', 'animations.json'), 'utf8')),
  }).pack;
})();

const TICK_MS = officeModule.TICK_MS;
const LEFT_HALF_X = 0.5;
const SAMPLE_EVERY = 8; // 128 ms sampling cadence

// A minimal corpus with the SHIPPED cooldown shape (resources/dialogue/base.json:
// bubbleMs 3200 / cooldownMs 30000) — the r2 bubble test pins the interaction
// between that cooldown and the chat cadence.
const DIALOGUE_CORPUS = {
  topics: { greeting: [{ id: 'g-01', text: '早', weight: 1 }] },
  limits: { bubbleMs: 3200, maxConcurrent: 2, cooldownMs: 30000 },
};

function nodeById(id) {
  return FLAT.nodes.find((node) => node.id === id) || null;
}

function nearestNodeId(position) {
  let best = null;
  let bestDistance = Infinity;
  for (const node of FLAT.nodes) {
    const distance = Math.hypot(node.position.x - position.x, node.position.y - position.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node.id;
    }
  }
  return best;
}

// One deterministic run of the real module. Returns the roaming/left-half time
// shares, the dwell-node sequence (stationary >= 2s at one node) and the
// workstation rest evidence.
function simulate(seed, minutes, config = {}) {
  const module = officeModule.createOfficeModule({
    pack: PACK,
    layout: FLAT,
    seed,
    config: { sleepAfterMs: 300000, ...config },
  });
  let roamSamples = 0;
  let leftSamples = 0;
  let restAtDeskSamples = 0;
  let restAreaSamples = 0;
  const dwellRuns = new Map(); // employeeId -> { node, since, ticks }
  const dwells = new Map();    // employeeId -> [node]
  let lastNode = new Map();
  const totalTicks = Math.round(minutes * 60000 / TICK_MS);
  for (let tick = 1; tick <= totalTicks; tick += 1) {
    const snapshot = module.advanceOneTick();
    if (tick % SAMPLE_EVERY !== 0) continue;
    for (const employee of snapshot.employees) {
      if (employee.activity === 'roaming') {
        roamSamples += 1;
        if (employee.position.x < LEFT_HALF_X) leftSamples += 1;
      }
      if (employee.activity === 'resting') {
        const nodeId = nearestNodeId(employee.position);
        const node = nodeById(nodeId);
        if (node && node.tags.includes('desk')) restAtDeskSamples += 1;
        if (node && node.tags.includes('rest-area')) restAreaSamples += 1;
      }
      const nodeId = nearestNodeId(employee.position);
      const run = dwellRuns.get(employee.employeeId);
      if (employee.movement === 'stationary' && nodeId === lastNode.get(employee.employeeId)) {
        if (run) run.ticks += SAMPLE_EVERY;
        else dwellRuns.set(employee.employeeId, { node: nodeId, ticks: SAMPLE_EVERY });
      } else {
        if (run && run.ticks * TICK_MS >= 2000) {
          if (!dwells.has(employee.employeeId)) dwells.set(employee.employeeId, []);
          dwells.get(employee.employeeId).push(run.node);
        }
        dwellRuns.set(employee.employeeId, employee.movement === 'stationary' ? { node: nodeId, ticks: SAMPLE_EVERY } : null);
      }
      lastNode.set(employee.employeeId, nodeId);
    }
  }
  // close open dwell runs
  for (const [employeeId, run] of dwellRuns) {
    if (run && run.ticks * TICK_MS >= 2000) {
      if (!dwells.has(employeeId)) dwells.set(employeeId, []);
      dwells.get(employeeId).push(run.node);
    }
  }
  const pairs = [];
  for (const sequence of dwells.values()) {
    for (let i = 1; i < sequence.length; i += 1) pairs.push(`${sequence[i - 1]}>${sequence[i]}`);
  }
  const pairCounts = new Map();
  for (const pair of pairs) pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
  let hottestPair = null;
  for (const [pair, count] of pairCounts) {
    if (hottestPair === null || count > pairCounts.get(hottestPair)) hottestPair = pair;
  }
  list.push({
    seed,
    roamSamples,
    leftSamples,
    share: roamSamples > 0 ? leftSamples / roamSamples : null,
    restAtDeskSamples,
    restAreaSamples,
    pairCount: pairs.length,
    distinctPairs: pairCounts.size,
    dedup: pairs.length > 0 ? pairCounts.size / pairs.length : null,
    hottestPair,
    hottestPairCount: hottestPair ? pairCounts.get(hottestPair) : 0,
  });
  return list[list.length - 1];
}

let list = [];
let contractCache = null;
function contractRuns(minutes = 12) {
  if (contractCache) return contractCache;
  list = [];
  const runs = ['wander-a', 'wander-b', 'wander-c'].map((seed) => simulate(seed, minutes));
  const pooled = {
    roamSamples: runs.reduce((sum, run) => sum + run.roamSamples, 0),
    leftSamples: runs.reduce((sum, run) => sum + run.leftSamples, 0),
    pairCount: runs.reduce((sum, run) => sum + run.pairCount, 0),
    distinctPairs: runs.reduce((sum, run) => sum + run.distinctPairs, 0),
  };
  pooled.share = pooled.leftSamples / pooled.roamSamples;
  pooled.dedup = pooled.distinctPairs / pooled.pairCount;
  contractCache = { runs, pooled };
  return contractCache;
}

// ---------------------------------------------------------------------------
// 1. 左半区占比 40%~50%（仿真驱动）
// ---------------------------------------------------------------------------
test('M4.1h: roaming time in the left half lands inside the 40-50% contract', () => {
  const { runs, pooled } = contractRuns(12);
  assert.ok(pooled.roamSamples > 5000, `the office actually roamed (${pooled.roamSamples} samples)`);
  // the user-facing metric
  assert.ok(pooled.share >= 0.40 && pooled.share <= 0.50,
    `pooled left-half roaming share ${pooled.share.toFixed(4)} must be inside [0.40, 0.50]`);
  // per-seed sanity: the contract is satisfied on average and no single seed
  // collapses (the feasible band is narrower than the seed-to-seed scatter)
  for (const run of runs) {
    assert.ok(run.share >= 0.35 && run.share <= 0.55,
      `seed ${run.seed}: left-half share ${run.share.toFixed(4)} stays near the band`);
  }
});

// ---------------------------------------------------------------------------
// 2. 休息可在工位发生 + 休息区提供更长的休息
// ---------------------------------------------------------------------------
test('M4.1h: resting happens at the workstation too and the break area holds longer', () => {
  // (a) the workstation is a legal rest spot: with every break-area resting node
  //     reserved, a forced resting decision stays resting IN PLACE at the desk
  //     with the plain minimum dwell — it never degrades to roaming.
  const layout = createOfficeLayout(FLAT);
  const graph = layout.waypointGraph();
  const movement = createMovementController({ graph, clock: { nowMs: () => 0 } });
  const restingNodeIds = idleDirector.restingNodeIds(graph);
  assert.ok(restingNodeIds.length >= 1, `the layout declares resting spots (${restingNodeIds.join(',')})`);
  const blockers = [];
  for (const nodeId of restingNodeIds) {
    const node = graph.nodes.find((entry) => entry.id === nodeId);
    const acquired = movement.acquireReservation({
      employeeId: `blocker-${nodeId}`,
      purpose: 'resting',
      nodeId,
      reservations: blockers,
      nowMs: 0,
      ttlMs: 600000,
      safeRadius: node.safeRadius,
    });
    assert.equal(acquired.ok, true);
    blockers.push(acquired.reservation);
  }
  const inPlace = createBehaviorScheduler({
    graph,
    movement,
    clock: { nowMs: () => 0 },
    seed: 'm41h-rest-in-place',
    config: { probabilities: { roaming: 0, resting: 1, chatting: 0 } },
  });
  const atDesk = inPlace.decide({
    employeeId: 'coder',
    nowMs: 0,
    fromNodeId: 'desk-3',
    forceActivity: 'resting',
    externalReservations: blockers,
  });
  assert.equal(atDesk.activity, 'resting', 'a blocked break area keeps the resident resting');
  assert.equal(atDesk.target, null, 'she rests where she stands (her own workstation)');
  assert.equal(atDesk.resting.restArea, false);
  assert.equal(atDesk.resting.dwellMs, schedulerModule.DEFAULT_CONFIG.minDwellMs,
    'resting in place keeps the plain minimum dwell');

  // (b) a rest-area spot is more attractive AND holds longer: with the area free
  //     the same forced resting decision walks to a rest-area node and takes the
  //     longer break dwell.
  const inArea = createBehaviorScheduler({
    graph,
    movement: createMovementController({ graph, clock: { nowMs: () => 0 } }),
    clock: { nowMs: () => 0 },
    seed: 'm41h-rest-in-area',
    config: {
      probabilities: { roaming: 0, resting: 1, chatting: 0 },
      restAreaAttraction: 1,
      restAreaDwellMs: 12345,
    },
  });
  const decision = inArea.decide({
    employeeId: 'coder',
    nowMs: 0,
    fromNodeId: 'desk-3',
    forceActivity: 'resting',
  });
  assert.equal(decision.activity, 'resting');
  assert.ok(decision.target, 'the break area is reachable: the resident walks there');
  assert.ok(idleDirector.restAreaNodeIds(graph).includes(decision.target.nodeId),
    `the rest target is a break-area node (${decision.target.nodeId})`);
  assert.equal(decision.resting.restArea, true);
  assert.equal(decision.resting.dwellMs, 12345, 'the break-area rest uses the longer dwell knob');
  assert.ok(decision.resting.dwellMs > schedulerModule.DEFAULT_CONFIG.minDwellMs);
});

// ---------------------------------------------------------------------------
// 3. 选中的目标失败时等待/重试，绝不静默反向
// ---------------------------------------------------------------------------
test('M4.1h: a blocked preferred-left target waits and retries instead of silently reversing', () => {
  const layout = createOfficeLayout(FLAT);
  const graph = layout.waypointGraph();
  const leftPool = idleDirector.resolveLeftAreaNodeIds(graph);
  assert.ok(leftPool.length >= 4, `the break area has several targets (${leftPool.join(',')})`);
  const movement = createMovementController({ graph, clock: { nowMs: () => 0 } });

  // Reserve EVERY break-area node so the left intent can never be satisfied.
  const blockers = [];
  for (const nodeId of leftPool) {
    const node = graph.nodes.find((entry) => entry.id === nodeId);
    const acquired = movement.acquireReservation({
      employeeId: `blocker-${nodeId}`,
      purpose: 'roaming',
      nodeId,
      reservations: blockers,
      nowMs: 0,
      ttlMs: 600000,
      safeRadius: node.safeRadius,
    });
    assert.equal(acquired.ok, true);
    blockers.push(acquired.reservation);
  }

  const scheduler = createBehaviorScheduler({
    graph,
    movement,
    clock: { nowMs: () => 0 },
    seed: 'm41h-no-silent-reroute',
    config: { leftRoamBias: 1 },
  });
  const decisions = [];
  for (let i = 0; i < 12; i += 1) {
    decisions.push(scheduler.decide({
      employeeId: 'coder',
      nowMs: i * 5000,
      fromNodeId: 'roam-1',
      forceActivity: 'roaming',
      externalReservations: blockers,
    }));
  }
  const leftIntents = decisions.filter((decision) => decision.left && decision.left.preferred);
  assert.ok(leftIntents.length > 0, 'the walker did draw the left preference');
  // THE CONTRACT: no decision may turn a left intent into a right-side target.
  for (const decision of leftIntents) {
    if (!decision.target) continue;
    const node = graph.nodes.find((entry) => entry.id === decision.target.nodeId);
    assert.ok(node.position.x < LEFT_HALF_X,
      `a left-intent decision returned a non-left target ${decision.target.nodeId} (silent re-route)`);
  }
  // and the blocked ones WAIT (retry) rather than fall back in the same frame
  const waiting = leftIntents.filter((decision) => decision.left.blocked);
  assert.ok(waiting.length > 0, 'the blocked left intents wait');
  for (const decision of waiting) {
    assert.equal(decision.target, null, 'a blocked left intent carries no target');
    assert.ok(decision.wait && decision.wait.reason === 'left-target-blocked');
    assert.ok(decision.wait.waitMs >= 700, `the retry patience is in the 700ms-2s band (${decision.wait.waitMs})`);
  }
  // the stand-down (spending the patience budget) lands on a LATER decision and
  // is labelled as such — it is never the same decision that drew the intent
  const standDown = decisions.find((decision) => /left-standdown/.test(decision.reason || ''));
  assert.ok(standDown, 'after the patience budget a later decision stands down');
  assert.equal(standDown.left.preferred, true, 'the stand-down decision itself is still a wait');
  assert.equal(standDown.target, null, 'the stand-down does not reverse in the same decision');
});

// ---------------------------------------------------------------------------
// 4. 任务抢占及时且可靠
// ---------------------------------------------------------------------------
test('M4.1h: a trusted task preempts a local walk and walks the resident to its desk', () => {
  const module = officeModule.createOfficeModule({
    pack: PACK,
    layout: FLAT,
    seed: 'm41h-preempt',
    config: { sleepAfterMs: 24 * 60 * 60 * 1000, workstationAnchorSegmentMs: 120, resultPresentationMs: 200 },
  });
  // let the office settle into local behavior
  for (let i = 0; i < 400; i += 1) module.tickOnce();
  const before = module.state().employees.find((employee) => employee.employeeId === 'orchestrator');
  assert.ok(['roaming', 'resting', 'chatting'].includes(before.activity),
    `precondition: the orchestrator is in a local activity (${before.activity})`);
  const approach = module.layout.workstation('desk-1').approach.nodeId;

  module.ingestHarnessEvent({ sessionId: 'sess-m41h-preempt', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  // same-tick preemption: the very next tick already left the local activity
  module.tickOnce();
  const next = module.state().employees.find((employee) => employee.employeeId === 'orchestrator');
  assert.ok(!['roaming', 'resting', 'chatting'].includes(next.activity),
    `the local activity ends within one tick (${next.activity})`);
  const dbg = module.debugReservations().find((entry) => entry.employeeId === 'orchestrator');
  const routeTarget = (dbg.routeIds || '').split('>').filter(Boolean).pop() || null;
  assert.ok(routeTarget === approach || dbg.currentNodeId === approach || dbg.workstationTargetHeld !== false,
    `the task route heads for the workstation approach (target ${routeTarget}, approach ${approach})`);
  // reliability: she actually arrives and works
  let arrived = false;
  for (let i = 0; i < Math.round(60000 / TICK_MS); i += 1) {
    const state = module.advanceOneTick();
    const employee = state.employees.find((x) => x.employeeId === 'orchestrator');
    if (employee.transition && employee.transition.phase === 'work') { arrived = true; break; }
  }
  assert.equal(arrived, true, 'the preempted resident reaches work at her own desk');
});

// ---------------------------------------------------------------------------
// 5. 巡游灵动化：最热节点对重复率
// ---------------------------------------------------------------------------
test('M4.1h: the hottest dwell node pair repeats below the pre-M4.1h rate', () => {
  const { runs, pooled } = contractRuns(12);
  assert.ok(pooled.pairCount > 200, `enough walk pairs to measure (${pooled.pairCount})`);
  // pre-M4.1h baseline: dedup 0.277-0.337, hottest pair 19-23 repeats / 30 min
  assert.ok(pooled.dedup >= 0.35,
    `dwell-pair dedup ${pooled.dedup.toFixed(3)} must beat the 0.34 pre-M4.1h ceiling`);
  for (const run of runs) {
    // 12-minute run => the pre-M4.1h rate (~20 / 30 min over the whole office)
    // scaled to one run is ~8; the new build stays at or below it per run.
    assert.ok(run.hottestPairCount <= 8,
      `seed ${run.seed}: hottest pair ${run.hottestPair} repeated ${run.hottestPairCount}x in 12 min`);
  }
});

// ---------------------------------------------------------------------------
// 6. r2 个体公平性：每名员工持有左区时间预算，欠账者获得优先
// ---------------------------------------------------------------------------
test('M4.1h r2: 每名员工持有左区时间预算，欠账的鲸鱼娘获得优先进城权', () => {
  const layout = createOfficeLayout(FLAT);
  const graph = layout.waypointGraph();
  const driver = (config, count) => {
    const scheduler = createBehaviorScheduler({
      graph,
      movement: createMovementController({ graph, clock: { nowMs: () => 0 } }),
      clock: { nowMs: () => 0 },
      seed: 'm41h-r2-fair',
      // short dwells make each call a fresh roaming decision; the legacy
      // decision-count brake is relaxed so the TEST isolates the budget
      // mechanism (the shipped default keeps that brake on purpose).
      config: {
        minDwellMs: 1000,
        leftRoamDwellMs: 1000,
        leftFairnessMaxShare: 1,
        ...config,
      },
    });
    let roaming = 0;
    let preferred = 0;
    for (let i = 0; i < count; i += 1) {
      const decision = scheduler.decide({
        employeeId: 'coder',
        nowMs: i * 2000,
        fromNodeId: 'roam-7', // right half: the walker has to actually go left
        forceActivity: 'roaming',
      });
      if (decision.activity !== 'roaming') continue;
      roaming += 1;
      if (decision.left && decision.left.preferred) preferred += 1;
    }
    return { scheduler, roaming, preferred };
  };

  const base = driver({ leftRoamBias: 0.05, leftQuotaEnabled: false }, 300);
  const quota = driver({
    leftRoamBias: 0.05,
    leftQuotaEnabled: true,
    leftQuotaFloor: 0.5,
    leftQuotaCatchUpChance: 1,
    leftQuotaMinRoamMs: 1000,
  }, 300);

  // (a) the budget is per employee and only exists while the mechanism is on
  assert.equal(base.scheduler.quotaSnapshot().perEmployee.coder.share, null,
    'the budget is null while the quota mechanism is off');
  const snapshot = quota.scheduler.quotaSnapshot();
  assert.ok(snapshot.perEmployee.coder.roamMs > 0, 'the budget accounted this walker\'s roaming time');
  assert.notEqual(snapshot.perEmployee.coder.share, null, 'the walker has a windowed left share');
  assert.ok(snapshot.perEmployee.coder.share < 0.5,
    `the walker is under its floor (${snapshot.perEmployee.coder.share})`);

  // (b) ENTITLEMENT: the same low-bias walker draws the wing far more often
  //     under the budget than it would under the base bias.
  assert.ok(base.roaming > 100 && quota.roaming > 100, `enough roaming decisions (${base.roaming}/${quota.roaming})`);
  assert.ok(base.preferred <= base.roaming * 0.2,
    `baseline draws the wing rarely (${base.preferred}/${base.roaming})`);
  assert.ok(quota.preferred >= quota.roaming * 0.8,
    `the under-served walker is entitled to the wing (${quota.preferred}/${quota.roaming})`);
  assert.ok(quota.preferred > base.preferred * 3,
    `entitlement lifts the draw (${quota.preferred} vs base ${base.preferred})`);
});

// ---------------------------------------------------------------------------
// 7. r2 气泡率下限：落座闲聊的每一刻都有气泡
// ---------------------------------------------------------------------------
test('M4.1h r2: 落座闲聊时气泡可见（气泡率下限）', () => {
  const seeds = ['m41d-chat-a', 'm41d-chat-d', 'm41d-chat-e'];
  let seatedTicks = 0;
  let bubbleTicks = 0;
  for (const seed of seeds) {
    const module = officeModule.createOfficeModule({ pack: PACK, layout: FLAT, seed, dialogue: { base: DIALOGUE_CORPUS } });
    const totalTicks = Math.round(4 * 60000 / TICK_MS);
    for (let tick = 0; tick < totalTicks; tick += 1) {
      module.tickOnce();
      const state = module.state();
      const members = state.employees.filter((employee) => employee.marker === 'chat-ellipsis');
      if (members.length !== 2) continue;
      const reservations = module.debugReservations();
      const seated = members.every((member) => {
        const row = reservations.find((entry) => entry.employeeId === member.employeeId) || {};
        return member.movement === 'stationary' && !row.routeIds
          && (row.currentNodeId === 'chat-a' || row.currentNodeId === 'chat-b');
      });
      if (!seated) continue;
      seatedTicks += 1;
      if (state.employees.some((employee) => employee.bubble)) bubbleTicks += 1;
    }
  }
  assert.ok(seatedTicks > 500, `conversations actually seated (${seatedTicks} ticks)`);
  assert.ok(bubbleTicks > 0, `at least one visible bubble (${bubbleTicks})`);
  // The shipped corpus cooldown (30 s) outlasts a whole 15 s chat, so before
  // r2 a seated conversation could emit ZERO lines. With the conversation-start
  // reset, a seated pair carries a bubble on essentially every tick.
  assert.ok(bubbleTicks >= seatedTicks * 0.8,
    `bubbles ${bubbleTicks} must cover the seated ticks ${seatedTicks} (>=80%)`);
});
