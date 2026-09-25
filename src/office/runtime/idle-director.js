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
// the scheduler's keep-away split and the movement contract.
// M4.1h (2026-09-24 巡游/休息区): the user-facing contract is now "巡游时要去左半区
// 的概率约 40%", so the default moved 0.5 → 0.4 and the value is a settings
// knob (`leftRoamBias`, office-module) instead of a compile-time constant.
const DEFAULT_LEFT_ROAM_BIAS = 0.42;

// M4.1h: the left-rest PREFERENCE used to switch itself off when the geometric
// left already held LEFT_PREFERENCE_MIN_SHARE (0.5) of the roaming pool. That
// was a CLIFF, not a safety net: the compiled flat layout sat at 4/9 = 44%, so
// adding a single left node (5/10 = 50%) silently disabled the preference and
// the wing went dark again mid-experiment. The share test is gone — the
// preference is active whenever a left pool exists and the bias is non-zero,
// which is exactly the knob the settings expose. `leftPreferenceActive` stays
// exported (tests and other callers use it) but now only answers "is there a
// left pool to prefer".
function leftPreferenceActive(graph) {
  return resolveLeftAreaNodeIds(graph).length > 0 && roamingCandidateIds(graph).length > 1;
}

// M4.1h: the resting-tagged spots a `resting` decision may walk to. The pool is
// independent of the left area (a layout may declare rest spots elsewhere), but
// on the compiled flat layout every one of them lives in the left wing — see
// `restAreaNodeIds`, which is what the scheduler treats as the ATTRACTIVE break
// area (longer dwell + a preference share).
function restingNodeIds(graph) {
  return graphNodes(graph)
    .filter((node) => node && typeof node.id === 'string' && Array.isArray(node.tags)
      && node.tags.includes('resting'))
    .map((node) => node.id)
    .sort();
}

function restAreaNodeIds(graph) {
  const left = new Set(resolveLeftAreaNodeIds(graph));
  return restingNodeIds(graph).filter((id) => left.has(id));
}

// M4.1h: the nodes a layout EXPLICITLY declares as the break area (the
// rest-area/lounge tag). Distinct from `resolveLeftAreaNodeIds`, which also
// accepts a GEOMETRIC guess for layouts that declare nothing: the break-area
// behaviours that are promises about the space (a longer roam hold, the resting
// attraction) must only apply where the layout really says "this is the break
// area", never to a synthetic graph's incidental left nodes.
function restAreaTaggedNodeIds(graph) {
  return graphNodes(graph)
    .filter((node) => node && typeof node.id === 'string' && Array.isArray(node.tags)
      && node.tags.some((tag) => REST_AREA_TAGS.includes(tag)))
    .map((node) => node.id)
    .sort();
}

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
// M4.1h: an EXPLICIT declaration (rest-area/lounge/left-wing/left tag) now
// REPLACES the geometric guess instead of joining it. The geometric rule exists
// for layouts that declare nothing (the canonical isometric fixture); a layout
// that names its break area means exactly those nodes, and the union used to
// drag corridor nodes (and, after the left-wing extension, the bottom-aisle
// transit node at x=0.55) into the "left half" pool — which silently inflated
// the left-target share with targets that are not in the left half at all.
function resolveLeftAreaNodeIds(graph) {
  const nodes = graphNodes(graph);
  if (nodes.length === 0) return [];
  const boundary = corridorBoundaryX(graph);
  const explicit = [];
  const geometric = [];
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !node.position || !Number.isFinite(node.position.x)) continue;
    const tags = Array.isArray(node.tags) ? node.tags : [];
    if (tags.some((tag) => REST_AREA_TAGS.includes(tag))) {
      explicit.push(node.id);
      continue;
    }
    // the geometric rule follows the scheduler's roaming candidate pool:
    // roaming-tagged and NOT a desk/workstation node (approach/leave nodes are
    // workstation furniture, never a rest area).
    const roaming = tags.includes('roaming') && !node.id.startsWith('desk-');
    if (roaming && node.position.x < boundary) geometric.push(node.id);
  }
  return (explicit.length > 0 ? explicit : geometric).sort();
}

// The scheduler's roaming candidate pool: roaming-tagged, non-desk nodes.
function roamingCandidateIds(graph) {
  return graphNodes(graph)
    .filter((node) => node && typeof node.id === 'string' && Array.isArray(node.tags)
      && node.tags.includes('roaming') && !node.id.startsWith('desk-'))
    .map((node) => node.id)
    .sort();
}

// M4.1h: `leftPreferenceActive` is declared above (it now only asks whether a
// left pool exists at all — the old "minority share" cliff is documented there).

function createIdleDirector({
  seed = 'office-seed',
  rng = null,
  probabilities = null,
  cooldownsMs = null,
  leftRoamBias = DEFAULT_LEFT_ROAM_BIAS,
} = {}) {
  const weights = { ...DEFAULT_PROBABILITIES, ...(probabilities || {}) };
  const cooldowns = { ...DEFAULT_COOLDOWNS_MS, ...(cooldownsMs || {}) };
  let bias = typeof leftRoamBias === 'number' && Number.isFinite(leftRoamBias)
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

  // Seeded left-rest-area preference for a roaming target pick. The share is
  // the configurable bias (default 0.4 = "巡游时约 40% 的计划偏向左半区").
  function prefersLeftArea({ employeeId } = {}) {
    return rngFor(employeeId)() < bias;
  }

  // M4.1h: LIGHT personality per employee — three bounded multipliers drawn
  // ONCE per employee from the same seeded stream (deterministic, no global
  // PRNG). They only NUDGE existing weights; they can never flip a rule:
  //   curiosity    0.75..1.25  → roam distance appetite (detour / mid-route换点)
  //   sociability  0.75..1.25  → chat craving threshold
  //   restfulness  0.75..1.25  → rest preference share and rest dwell length
  // A 1.0 personality is the neutral default, so a profile-free employee
  // (unknown id) behaves exactly like the pre-M4.1h scheduler.
  const personalities = new Map();
  function personalityFor(employeeId) {
    let found = personalities.get(employeeId);
    if (found) return found;
    const stream = rngFor(employeeId);
    const draw = () => 0.75 + stream() * 0.5;
    found = Object.freeze({
      curiosity: draw(),
      sociability: draw(),
      restfulness: draw(),
    });
    personalities.set(employeeId, found);
    return found;
  }

  // Live reconfiguration (settings). Values are validated/clamped exactly like
  // the constructor arguments; unknown keys are ignored.
  function configure(partial) {
    const next = partial || {};
    if (Number.isFinite(next.leftRoamBias)) bias = Math.min(1, Math.max(0, next.leftRoamBias));
    if (next.probabilities && typeof next.probabilities === 'object') {
      for (const activity of DIRECTOR_ACTIVITIES) {
        if (Number.isFinite(next.probabilities[activity])) weights[activity] = next.probabilities[activity];
      }
    }
    if (next.cooldownsMs && typeof next.cooldownsMs === 'object') {
      for (const activity of DIRECTOR_ACTIVITIES) {
        if (Number.isFinite(next.cooldownsMs[activity])) cooldowns[activity] = next.cooldownsMs[activity];
      }
    }
    return config();
  }

  function config() {
    return Object.freeze({
      probabilities: Object.freeze({ ...weights }),
      cooldownsMs: Object.freeze({ ...cooldowns }),
      leftRoamBias: bias,
    });
  }

  function reset(employeeId) {
    startedAt.delete(employeeId);
    personalities.delete(employeeId);
    return Object.freeze({ ok: true, employeeId });
  }

  return Object.freeze({
    choose: Object.freeze(choose),
    note: Object.freeze(note),
    prefersLeftArea: Object.freeze(prefersLeftArea),
    personality: Object.freeze(personalityFor),
    configure: Object.freeze(configure),
    reset: Object.freeze(reset),
    get config() { return config(); },
  });
}

module.exports = {
  createIdleDirector,
  resolveLeftAreaNodeIds,
  restingNodeIds,
  restAreaNodeIds,
  restAreaTaggedNodeIds,
  leftPreferenceActive,
  corridorBoundaryX,
  DIRECTOR_ACTIVITIES,
  REST_AREA_TAGS,
  DEFAULT_PROBABILITIES,
  DEFAULT_COOLDOWNS_MS,
  DEFAULT_LEFT_ROAM_BIAS,
  PERSONALITY_RANGE: Object.freeze({ min: 0.75, max: 1.25 }),
};
