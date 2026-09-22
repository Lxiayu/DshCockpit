'use strict';

// src/office/runtime/idle-director.js — M4.1g idle behavior director.
//
// The "what should an idle employee do next" chooser for the local behavior
// vocabulary roaming/resting/chatting. Sleeping deliberately stays OUT of this
// choice: the scheduler owns its gates (idle threshold, own desk only, no
// unfinished binding, healthy sync, concurrency cap, finite duration), and the
// director is consulted only once those gates let the employee stay awake.
//
// Pure and deterministic: no Electron/Pixi/DOM/fs/network/LLM access, no
// wall-clock and no PRNG-global access (seeded per-employee mulberry32 stream,
// or one injected rng function for tests). Identical seed + identical call
// sequence => identical choices.
//
// Contracts:
// - random WITH preference: the base probabilities (roaming 60 / resting 25 /
//   chatting 15) still drive the pick, but every activity carries a COOLDOWN —
//   after an activity starts it cannot be chosen again for the SAME employee
//   before the cooldown elapses, so nobody rests (or chats) twice in a row and
//   no behavior is repeated forever
// - nothing choosable (all on cooldown, or zero configured weight) degrades to
//   roaming: the office never stalls
// - left rest area: resolveLeftAreaNodeIds(graph) names the roaming nodes left
//   of the seated work columns — the whale-girls used to never walk there.
//   An explicit rest-area/lounge/left-wing tag wins when a layout declares the
//   area; otherwise the geometry decides (x < corridorBoundaryX). The director
//   additionally exposes a seeded left-roam PREFERENCE (prefersLeftArea) so the
//   scheduler can bias roaming targets toward that pool without a hard rule.

const DEFAULT_PROBABILITIES = Object.freeze({ roaming: 0.6, resting: 0.25, chatting: 0.15 });

// The choosable local activities, in the same threshold order the plain
// probability roll uses (roaming < resting < chatting).
const DIRECTOR_ACTIVITIES = Object.freeze(['roaming', 'resting', 'chatting']);

// Per-activity cooldowns (ms of simulated time): how long after an activity
// STARTS before the same activity may be chosen again for that employee.
// Roaming is the liveness filler and has none; resting/chatting carry a short
// window only — long enough that the same behavior never repeats back to back
// (the dwell is 4s), short enough that the office keeps its calm mix (a long
// resting cooldown turns every rest into a walk and jams the corridors).
const DEFAULT_COOLDOWNS_MS = Object.freeze({ roaming: 0, resting: 8000, chatting: 8000 });

// Share of roaming picks that PREFER the left rest-area pool (seeded). A
// preference, never a hard rule: crowded/unreachable left nodes still lose to
// the scheduler's keep-away split and the movement contract. The share stays
// well under half because the left wing is reachable through a single corridor
// node in the compiled layouts — a stronger bias would jam that chokepoint and
// stall every other walker behind it.
const DEFAULT_LEFT_ROAM_BIAS = 0.5;

// The preference exists to pull walkers toward an area the office UNDER-USES.
// When the geometric left already holds at least half of the roaming pool
// (the isometric canonical layout wraps its ring around the left of the desk
// grid), the pool needs no pull and the preference is switched off for that
// graph — see resolveLeftAreaNodeIds().preference.
const LEFT_PREFERENCE_MIN_SHARE = 0.5;

// Tags a layout may use to declare the rest area explicitly.
const REST_AREA_TAGS = Object.freeze(['rest-area', 'restarea', 'rest_area', 'lounge', 'left-wing', 'left']);

// Deterministic PRNG helpers (xmur3 hash + mulberry32); never the PRNG global.
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function next() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (Math.imul(t ^ (t >>> 7), 61 | t) ^ t) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function graphNodes(graph) {
  return graph && Array.isArray(graph.nodes) ? graph.nodes : [];
}

// The x boundary of the walkable corridor: the MEDIAN x of the roaming ring
// (the walkable candidates the scheduler draws from — desk/workstation nodes
// are the seated columns, not corridor). Everything left of it is the left rest
// area: the compiled flat layout's left wing plus the left half of its
// corridor. A graph without roaming nodes falls back to the median of all xs.
function corridorBoundaryX(graph) {
  const nodes = graphNodes(graph).filter((node) => node && node.position && Number.isFinite(node.position.x));
  if (nodes.length === 0) return 1;
  const roaming = nodes.filter((node) => Array.isArray(node.tags)
    && node.tags.includes('roaming') && !node.id.startsWith('desk-'));
  const source = roaming.length > 0 ? roaming : nodes;
  const xs = source.map((node) => node.position.x).sort((a, b) => a - b);
  return xs.length % 2 === 1 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
}

// Roaming nodes that belong to the left rest area, sorted by id for stability.
// An explicit tag (rest-area/lounge/left-wing/left) qualifies a node even when
// it is not roaming-tagged or sits right; geometric left-of-the-work-columns
// qualifies the rest.
function resolveLeftAreaNodeIds(graph) {
  const nodes = graphNodes(graph);
  if (nodes.length === 0) return [];
  const boundary = corridorBoundaryX(graph);
  const left = [];
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !node.position || !Number.isFinite(node.position.x)) continue;
    const tags = Array.isArray(node.tags) ? node.tags : [];
    const explicit = tags.some((tag) => REST_AREA_TAGS.includes(tag));
    // the geometric rule follows the scheduler's roaming candidate pool:
    // roaming-tagged and NOT a desk/workstation node (approach/leave nodes are
    // workstation furniture, never a rest area).
    const roaming = tags.includes('roaming') && !node.id.startsWith('desk-');
    if ((roaming && node.position.x < boundary) || explicit) left.push(node.id);
  }
  return left.sort();
}

// The scheduler's roaming candidate pool: roaming-tagged, non-desk nodes.
function roamingCandidateIds(graph) {
  return graphNodes(graph)
    .filter((node) => node && typeof node.id === 'string' && Array.isArray(node.tags)
      && node.tags.includes('roaming') && !node.id.startsWith('desk-'))
    .map((node) => node.id)
    .sort();
}

// Whether the left-rest-area TARGET preference should pull walkers for this
// graph. An explicitly declared rest area always counts. A geometric left pool
// only counts while it is a MINORITY of the roaming candidates: when the left
// already holds at least half of the ring (the isometric canonical layout
// wraps its roam ring around the left of the desk grid) the office already
// uses that side and re-ordering the candidates only distorts the walk.
function leftPreferenceActive(graph) {
  const nodes = graphNodes(graph);
  const explicit = nodes.some((node) => Array.isArray(node.tags)
    && node.tags.some((tag) => REST_AREA_TAGS.includes(tag)));
  if (explicit) return true;
  const pool = resolveLeftAreaNodeIds(graph);
  const candidates = roamingCandidateIds(graph);
  if (pool.length === 0 || candidates.length === 0) return false;
  return pool.length < candidates.length * LEFT_PREFERENCE_MIN_SHARE;
}

function createIdleDirector({
  seed = 'office-seed',
  rng = null,
  probabilities = null,
  cooldownsMs = null,
  leftRoamBias = DEFAULT_LEFT_ROAM_BIAS,
} = {}) {
  const weights = { ...DEFAULT_PROBABILITIES, ...(probabilities || {}) };
  const cooldowns = { ...DEFAULT_COOLDOWNS_MS, ...(cooldownsMs || {}) };
  const bias = typeof leftRoamBias === 'number' && Number.isFinite(leftRoamBias)
    ? Math.min(1, Math.max(0, leftRoamBias))
    : DEFAULT_LEFT_ROAM_BIAS;

  const streams = new Map(); // employeeId -> mulberry32 stream
  function rngFor(employeeId) {
    if (typeof rng === 'function') return rng; // injected stream (tests)
    let stream = streams.get(employeeId);
    if (!stream) {
      stream = mulberry32(xmur3(`${seed}:${employeeId}`)());
      streams.set(employeeId, stream);
    }
    return stream;
  }

  // employeeId -> { [activity]: startedAtMs } — the only history the director
  // keeps; the scheduler owns the actual current-activity state.
  const startedAt = new Map();
  function historyFor(employeeId) {
    let history = startedAt.get(employeeId);
    if (!history) {
      history = {};
      startedAt.set(employeeId, history);
    }
    return history;
  }

  function choose({ employeeId, atMs = 0 } = {}) {
    const at = Number.isFinite(atMs) ? atMs : 0;
    const history = startedAt.get(employeeId) || {};
    const available = {};
    let total = 0;
    for (const activity of DIRECTOR_ACTIVITIES) {
      const base = positiveNumber(weights[activity], 0);
      const cooldown = typeof cooldowns[activity] === 'number' && cooldowns[activity] > 0 ? cooldowns[activity] : 0;
      const last = history[activity];
      const blocked = cooldown > 0 && last !== undefined && at - last < cooldown;
      const weight = blocked ? 0 : base;
      available[activity] = Object.freeze({
        weight,
        blocked,
        cooldownMs: cooldown,
        lastAtMs: last === undefined ? null : last,
      });
      total += weight;
    }
    const frozenWeights = Object.freeze(available);
    if (total <= 0) {
      return Object.freeze({ activity: 'roaming', reason: 'idle-director:fallback', weights: frozenWeights, total: 0 });
    }
    let roll = rngFor(employeeId)() * total;
    let picked = DIRECTOR_ACTIVITIES[DIRECTOR_ACTIVITIES.length - 1];
    for (const activity of DIRECTOR_ACTIVITIES) {
      roll -= available[activity].weight;
      if (roll < 0) {
        picked = activity;
        break;
      }
    }
    return Object.freeze({
      activity: picked,
      reason: `idle-director:${picked}`,
      weights: frozenWeights,
      total,
    });
  }

  function note({ employeeId, activity, atMs = 0 } = {}) {
    if (!DIRECTOR_ACTIVITIES.includes(activity)) return Object.freeze({ ok: false, code: 'ACTIVITY_NOT_DIRECTED' });
    historyFor(employeeId)[activity] = Number.isFinite(atMs) ? atMs : 0;
    return Object.freeze({ ok: true, employeeId, activity });
  }

  // Seeded left-rest-area preference for a roaming target pick.
  function prefersLeftArea({ employeeId } = {}) {
    return rngFor(employeeId)() < bias;
  }

  function reset(employeeId) {
    startedAt.delete(employeeId);
    return Object.freeze({ ok: true, employeeId });
  }

  return Object.freeze({
    choose: Object.freeze(choose),
    note: Object.freeze(note),
    prefersLeftArea: Object.freeze(prefersLeftArea),
    reset: Object.freeze(reset),
    config: Object.freeze({
      probabilities: Object.freeze({ ...weights }),
      cooldownsMs: Object.freeze({ ...cooldowns }),
      leftRoamBias: bias,
    }),
  });
}

module.exports = {
  createIdleDirector,
  resolveLeftAreaNodeIds,
  leftPreferenceActive,
  corridorBoundaryX,
  DIRECTOR_ACTIVITIES,
  REST_AREA_TAGS,
  DEFAULT_PROBABILITIES,
  DEFAULT_COOLDOWNS_MS,
  DEFAULT_LEFT_ROAM_BIAS,
};
