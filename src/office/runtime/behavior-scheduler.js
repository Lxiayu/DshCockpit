'use strict';

// src/office/runtime/behavior-scheduler.js — Task 5 / SPEC-04.
//
// Local behavior scheduler for resident employees. Pure and deterministic:
// no Electron/Pixi/DOM/fs/network/LLM/Harness access, no wall-clock or PRNG-global access
// (fake clock + stable injected seed only).
//
// Contracts (SPEC-04 / character-state-machine / character-movement-system):
// - local behavior may ONLY produce roaming/resting/chatting/sleeping (plus
//   the transient 'continue'); it never produces running/attention/completed/
//   failed/tool facts and never writes a runtime transcript — chat is exposed
//   as a non-text icon/ellipsis marker with an accessibility label only
// - the office starts local behavior without waiting for Harness events
// - default decision probabilities: roaming 60% / resting 25% / chatting 15%,
//   rolled through the idle director (same base weights, plus per-activity
//   cooldowns so nobody repeats one behavior back to back)
// - minimum dwell time and chat cooldowns are honored
// - target selection goes through the injected movement controller's
//   waypoint/reservation contract (findRoute + acquireReservation): never a
//   teleport; unavailable targets pick a same-tag candidate or a short wait
// - at most ONE chat pair exists; chat-a/chat-b seats are reserved ATOMICALLY
//   (either failure cancels both); the pair keeps fixed seats and facing
// - sleeping unlocks after the configured idle threshold (default 300000 ms),
//   defaults to the personal desk, and is blocked by unfinished bindings or
//   sync != healthy
// - M4.1g: sleeping is a FINITE, CAPPED nap — at most `maxSleepers` residents
//   nap at once (default 2), one nap lasts a random 60–180s (configurable),
//   the sleeper then wakes into a local activity (once), and a post-nap
//   refractory keeps the office from instantly re-napping. An unfinished nap
//   CONTINUES: it never restarts a fresh cycle per dwell window (the old
//   re-entry every minDwellMs is what froze the whole office asleep).
// - trusted running/attention facts or explicit commands interrupt any local
//   activity immediately (releasing both chat reservations); sync=stale/
//   resyncing NEVER ends local behavior and never triggers sleeping
// - identical seed + identical call sequence => identical decisions

const profiles = require('./employee-profile.js');
const idleDirector = require('./idle-director.js');

const DEFAULT_PROBABILITIES = Object.freeze({ roaming: 0.6, resting: 0.25, chatting: 0.15 });

// M4.1e: personal space for PARKED bodies. The occupant gate keeps moving
// bodies 0.03 apart, which two 0.083-wide characters still overlap heavily
// when they stand still next to each other. Target selection therefore prefers
// candidates outside this radius of every peer's CURRENT position and only
// falls back to crowded ones when nothing else is reachable — a preference,
// never a block (liveness beats spacing).
const PERSONAL_SPACE_RATIO = 0.055;

// M4.1d follow-up: how long a resident must be idle before the chat craving
// above kicks in (ms of simulated time).
const CHAT_CRAVE_AFTER_MS = 45000;
const DEFAULT_SLEEP_AFTER_MS = 300000;
// M4.1g: how many residents may nap SIMULTANEOUSLY (the frozen office was five
// sleepers at once) and how long one nap lasts (random draw inside the range,
// or the fixed override). `sleepRefractoryMs` is the awake time a resident
// spends after a nap before the idle threshold may start the next one.
const DEFAULT_MAX_SLEEPERS = 2;
const DEFAULT_SLEEP_DURATION_RANGE_MS = Object.freeze({ minMs: 60000, maxMs: 180000 });
const DEFAULT_SLEEP_REFRACTORY_MS = 120000;
const DEFAULT_CONFIG = Object.freeze({
  probabilities: DEFAULT_PROBABILITIES,
  minDwellMs: 4000,
  chatCooldownMs: 20000,
  sleepAfterMs: DEFAULT_SLEEP_AFTER_MS,
  maxSleepers: DEFAULT_MAX_SLEEPERS,
  sleepDurationMs: null,
  sleepDurationRangeMs: DEFAULT_SLEEP_DURATION_RANGE_MS,
  sleepRefractoryMs: DEFAULT_SLEEP_REFRACTORY_MS,
  leftRoamBias: idleDirector.DEFAULT_LEFT_ROAM_BIAS,
  waitMs: 800,
  reservationTtlMs: 60000,
  chatSeatTtlMs: 120000,
  // ---- M4.1h (2026-09-24 巡游/休息区) ----------------------------------------
  // The share of roaming picks that target the left rest area. The default is
  // the settings default; the metric contract is "左半区时间占比 40%~50%".
  // (leftRoamBias IS this knob — kept as one name so the settings key, the
  // director and the scheduler can never drift apart.)
  // Patience budget for a PREFERRED-LEFT target that is unreachable/reserved:
  // the walker waits and retries for this many decisions instead of silently
  // turning the walk around in the same decision (the "只有一只往左走一小段又
  // 回来" defect). After the budget is spent the choice stands down for ONE
  // later decision (never the same one).
  leftRetryAttempts: 2,
  // How long a blocked-left retry waits before the next decision (the
  // assessment's suggested 700ms→2s patience band).
  leftRetryMs: 1500,
  // Share of `resting` decisions that walk to a rest-area (left, near the
  // furniture band) resting node instead of resting where they stand.
  restAreaAttraction: 0.6,
  // Dwell lengths: a rest-area node rests longest (the break area is where a
  // break is a break), any other resting waypoint rests a little, and resting
  // IN PLACE (desk / corridor, the M4.1e fallback) keeps the plain minimum
  // dwell — the office stays calm without every resident parking for 12s.
  restAreaDwellMs: 12000,
  restDwellMs: 6000,
  // A roaming visit to the left rest area lingers longer than a corridor stop
  // (the whale-girls "看一眼水吧再走"): the left half is where a patrol is
  // supposed to be worth watching. Other roaming stops keep minDwellMs.
  // Tuned with the headless harness (assessment doc §已实施): the left HOLD time
  // per visit — not the draw share — is what moves the measured left-half share,
  // because the wing's single-file corridor caps how many trips can be in flight.
  leftRoamDwellMs: 18000,
  // Share of roaming walks that re-target at an intermediate waypoint (one
  // fresh decision mid-walk) — "允许中途换点".
  midRouteRerouteChance: 0.12,
  // Share of roaming walks whose route takes a seeded micro-detour through one
  // extra waypoint (every leg still planned through the movement contract).
  detourChance: 0.15,
  // Light per-employee personality multipliers (curiosity/sociability/
  // restfulness, idle-director.personality). Off => every employee behaves
  // exactly like the neutral 1.0 profile.
  personality: true,
  // M4.1h fairness: the left preference is a per-decision DRAW, so without a
  // governor the employees who happen to be closest to the wing absorb it (the
  // assessment measured one employee at 40-56% of all left visits). A walker
  // whose recent roaming decisions were already mostly leftward stands down for
  // a while, and a walker already IN the left area does not draw the preference
  // at all (it is there — the pull is for getting there). Both are "no draw",
  // never a same-decision reversal.
  leftFairnessWindowMs: 180000,
  leftFairnessMaxShare: 0.5,
  leftFairnessMinDecisions: 6,
  // M4.1h demand-aware governor: the left wing is a single-file corridor with
  // six seats. Drawing the left preference while it is ALREADY busy produced the
  // worst outcome of both worlds — the walker waits (standing still is roaming
  // time spent in the right half) and the wing stays jammed. When this many
  // peers are already in the left half, the draw is skipped entirely instead.
  leftCrowdLimit: 3,
  // M4.1h fair rotation: after a successful left visit the walker gives the
  // break area back — left nodes are removed from its pool for this long, so the
  // wing rotates instead of being held by whoever reached it first (measured
  // before the rule: one seat held 68-86% left time while another sat at 0%,
  // and the aggregate share swung with whoever won that race).
  // DEFAULT 0 = OFF. Enabled it evens the per-seat distribution (measured
  // 0.18-0.64 vs 0.04-0.86) but drags the aggregate share below the 40% floor
  // (measured mean 0.384-0.397 over 7 seeds), because the wing's share comes
  // from HOLD time, not from visit count. Documented as a fairness lever, not a
  // default: see the assessment doc §已实施.
  leftAfterVisitCooldownMs: 0,
  // ---- M4.1h round 2 (2026-09-24 个体公平性) ---------------------------------
  // The draw above is a per-employee lottery, and because the left-half METRIC
  // is HOLD time (not visit count) the lottery's winners hoard the wing: the
  // assessment measured 0.00-0.81 per-employee left-half shares on the same
  // 30-minute window ("只有一只鲸鱼娘往左走"). A per-decision draw cannot fix
  // that; the office needs a per-employee TIME BUDGET.
  //
  // Each resident carries a decayed accountant of its own roaming time and the
  // share of it spent in the left half (integrated per tick from the node it
  // stands on; time constant `leftQuotaWindowMs` ≈ the 60-minute user window).
  // On a roaming decision:
  //   * share < floor          -> the walker is ENTITLED to the wing: it draws
  //                               with the high catch-up probability and holds
  //                               the ONE fair-lane claim while the other
  //                               under-served walkers queue
  //   * share > ceiling        -> the draw is TAPERED toward 0 (a give-back);
  //                               DEFAULT 1 = off, because measurement showed a
  //                               real ceiling costs ~0.05 pooled share across
  //                               11 seeds without tightening the band
  //   * in between             -> the plain probabilistic draw (base bias)
  // The office-wide total acts as a servo: the ceiling taper is suspended while
  // the aggregate is under `leftQuotaAggregateFloor` (fairness must never starve
  // the aggregate). Budget, not cooldown.
  leftQuotaEnabled: true,
  leftQuotaWindowMs: 480000,
  leftQuotaFloor: 0.30,
  leftQuotaCeiling: 1,
  leftQuotaMinRoamMs: 60000,
  leftQuotaCatchUpChance: 0.9,
  leftQuotaAggregateFloor: 0.4,
  // Bounded lifetime of the fair-lane claim (walk to the wing + one hold + a
  // generous margin); a claimant that gets stranded releases the lane here.
  leftQuotaClaimTtlMs: 90000,
  // M4.1h r3 corridor passage priority. Measured (r3 harness, 11 seeds): 70% of
  // preferred-left decisions found NO reachable left candidate — the wing's two
  // gateways (roam-6→roam-9, roam-4→roam-14) and its single chain are behind a
  // capacity-2 node, so ONE body parked on the first chain node made the whole
  // wing read "unreachable" for the moment. The decision then stood down and
  // the walker never left, which is the root of both the 0.000 individual floor
  // and the ~0.05 aggregate shortfall at 60 min. Every left intent now plans at
  // level 1 (past a parked body); under-served walkers plan at level 2 (past a
  // moving peer's route too). Capacity is still enforced by acquireReservation,
  // so a genuinely full target is skipped as before.
  leftCorridorPriority: true,
  // Widen LEVEL 2 to every left intent. Measurement: level 1 everywhere already
  // fixes the reachability; widening level 2 as well saturates the wing
  // (pooled share 0.516 at bias 0.5, over the 0.50 ceiling) and roughly halves
  // the chat seeds' bubbles, because the wing then stays permanently full.
  // DEFAULT false — reserved for experiments.
  leftCorridorPriorityAll: false,
  // M4.1h r2: after a chat pair is broken by a corridor yield (preemptLocal),
  // both members carry this cooldown so they cannot instantly re-pair with each
  // other and walk back into the same mutual step-gate block (measured on seed
  // m41d-chat-e: the same two employees re-formed a chat they could never seat
  // for 30 minutes, so no bubble ever appeared). DEFAULT 0 = OFF, like
  // leftAfterVisitCooldownMs: enabling it costs pooled left share (~0.05 over 11
  // seeds) and the fair lane already breaks the livelock in measurement, so it
  // ships as an opt-in guard.
  chatBreakCooldownMs: 0,
});
const LOCAL_ACTIVITIES = Object.freeze(['roaming', 'resting', 'chatting', 'sleeping']);
const INTERRUPT_REASONS = Object.freeze(['runtime-task', 'runtime-attention', 'explicit-command']);

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
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fail(code, extra) {
  return Object.freeze({ ok: false, code, ...(extra || {}) });
}

function facingBetween(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

function createBehaviorScheduler({ graph, movement, clock = null, seed = 'office-seed', config = null, employeeIds = null } = {}) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new TypeError('createBehaviorScheduler requires a waypoint graph');
  }
  if (!movement || typeof movement.findRoute !== 'function' || typeof movement.acquireReservation !== 'function') {
    throw new TypeError('createBehaviorScheduler requires a movement controller');
  }

  const mergedConfig = { ...DEFAULT_CONFIG, ...(config || {}) };
  const probabilities = { ...DEFAULT_PROBABILITIES, ...(mergedConfig.probabilities || {}) };
  const effectiveConfig = Object.freeze({ ...mergedConfig, probabilities: Object.freeze(probabilities) });
  const now = clock && typeof clock.nowMs === 'function' ? clock.nowMs : () => 0;

  const ids = employeeIds || [...profiles.RESIDENT_EMPLOYEE_IDS, profiles.COLLABORATOR_ID];
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

  // M4.1g: the livelier idle decision maker (roaming/resting/chatting with
  // per-activity cooldowns) and the left rest-area roaming pool. Both are
  // deterministic: the seeded rng streams key off the scheduler seed.
  const director = idleDirector.createIdleDirector({
    seed,
    probabilities,
    leftRoamBias: mergedConfig.leftRoamBias,
  });
  const leftAreaNodeIds = idleDirector.resolveLeftAreaNodeIds(graph);
  // M4.1h r2: the metric's own notion of "left half" (x < 0.5), used ONLY by the
  // per-employee fairness accountant so the budget tracks the user-facing
  // number. It is deliberately wider than `leftAreaNodeIds` (the tagged break
  // area): the transit nodes and roam-14 sit at x < 0.5 too, and a walker
  // holding there is inside the measured left half.
  const leftHalfNodeIdSet = new Set(
    graph.nodes
      .filter((node) => node && node.position && Number.isFinite(node.position.x) && node.position.x < 0.5)
      .map((node) => node.id)
  );
  // M4.1h: the rest spots, split into "the break area" (resting nodes inside the
  // left wing — the furniture band) and every other resting waypoint.
  const restAreaNodeIdSet = new Set(idleDirector.restAreaNodeIds(graph));
  // the EXPLICITLY tagged break area (flat: the same six wing nodes; synthetic
  // graphs without a declaration: empty, so no break-area promise is implied)
  const breakAreaNodeIdSet = new Set(idleDirector.restAreaTaggedNodeIds(graph));
  const restingNodeIds = idleDirector.restingNodeIds(graph);
  // M4.1g/M4.1h: the left-target preference is on whenever a left pool exists
  // (the old "minority share" switch-off cliff is gone — see idle-director).
  const leftPreferenceOn = idleDirector.leftPreferenceActive(graph);

  // Live settings (office-module.updateSettings): the mutable knobs are read
  // through `knob()`, never captured, so a settings change takes effect at the
  // next decision point exactly like the other delayed-effect settings.
  const live = { ...mergedConfig };
  function knob(key) { return live[key]; }

  const employees = new Map();
  for (const employeeId of ids) {
    const profile = profiles.getResidentProfile(employeeId) || (employeeId === profiles.COLLABORATOR_ID ? profiles.getCollaboratorProfile() : null);
    employees.set(employeeId, {
      employeeId,
      displayName: profile ? profile.displayName : employeeId,
      defaultSeat: profile ? profile.defaultSeat : null,
      cooldownUntil: 0,
      idleSince: now(),
      // M4.1g: no new nap before this logical time (post-nap refractory; set
      // whenever a nap ends, task-interrupt included).
      napRefractoryUntil: 0,
      current: null,
      // M4.1h: consecutive decisions whose PREFERRED-LEFT target was blocked,
      // and the one-shot stand-down flag that spends the patience budget in a
      // LATER decision (never the same one — no same-decision reversal).
      leftBlockedStreak: 0,
      leftStandDownOnce: false,
      leftCooldownUntilMs: 0,
      // M4.1h r2 fairness accountant: decayed roaming ms and left-half roaming
      // ms for this resident, integrated per decision (no wall clock beyond
      // `at`). `quotaWasRoaming` / `quotaWasLeft` describe the interval that
      // ends at the next settle.
      quotaAtMs: null,
      quotaRoamMs: 0,
      quotaLeftMs: 0,
      quotaWasRoaming: false,
      quotaWasLeft: false,
    });
  }

  const rngStreams = new Map();
  function rngFor(employeeId) {
    let rng = rngStreams.get(employeeId);
    if (!rng) {
      rng = mulberry32(xmur3(`${seed}:${employeeId}`)());
      rngStreams.set(employeeId, rng);
    }
    return rng;
  }

  const localReservations = [];
  let activeChatPair = null;

  function atOrDefault(nowMs) {
    return typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : now();
  }

  function allReservations(externalReservations) {
    return externalReservations && externalReservations.length > 0
      ? [...localReservations, ...externalReservations]
      : [...localReservations];
  }

  function reservations() {
    return Object.freeze(localReservations.map((reservation) => Object.freeze({ ...reservation })));
  }

  function releaseEmployeeReservations(employeeId) {
    for (let i = localReservations.length - 1; i >= 0; i -= 1) {
      if (localReservations[i].owner === employeeId) localReservations.splice(i, 1);
    }
  }

  function rollActivity(employeeId) {
    const r = rngFor(employeeId)();
    if (r < probabilities.roaming) return 'roaming';
    if (r < probabilities.roaming + probabilities.resting) return 'resting';
    return 'chatting';
  }

  function shuffled(list, rng) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function chatSeatNodes() {
    return graph.nodes
      .filter((node) => Array.isArray(node.tags) && node.tags.includes('chatting'))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  function nodeDistance(fromNodeId, toNodeId) {
    const from = nodesById.get(fromNodeId);
    const to = nodesById.get(toNodeId);
    if (!from || !to) return Infinity;
    return Math.hypot(from.position.x - to.position.x, from.position.y - to.position.y);
  }

  // Nearest eligible partner by normalized waypoint distance from the
  // initiator's current node. Candidates with unknown nodes never participate
  // (they must not win as pseudo distance zero); equal distances use the
  // documented deterministic tie-break: employeeId lexicographic order.
  function chooseChatPartner({ employeeId, at, candidates, fromNodeId }) {
    const eligible = [];
    for (const candidate of candidates || []) {
      if (!candidate || candidate.employeeId === employeeId) continue;
      if (typeof candidate.nodeId !== 'string' || !nodesById.has(candidate.nodeId)) continue;
      const other = employees.get(candidate.employeeId);
      if (!other) continue;
      // M4.1g: a resident inside a nap is NOT a chat candidate. Recruiting one
      // overwrote its active nap cycle (no wake, no sleep-ended log), and the
      // pair died on the next tick — the nap looked like it re-formed within
      // seconds, which is exactly the "开始小憩" spam this milestone fixes.
      if (other.current && other.current.activity === 'sleeping') continue;
      if (other.cooldownUntil > at) continue;
      if (activeChatPair && (activeChatPair.a === candidate.employeeId || activeChatPair.b === candidate.employeeId)) continue;
      eligible.push(candidate);
    }
    eligible.sort((a, b) => {
      const distanceA = nodeDistance(fromNodeId, a.nodeId);
      const distanceB = nodeDistance(fromNodeId, b.nodeId);
      if (distanceA !== distanceB) return distanceA - distanceB;
      return a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0;
    });
    return eligible.length > 0 ? eligible[0] : null;
  }

  function removeLocalReservation(id) {
    for (let i = localReservations.length - 1; i >= 0; i -= 1) {
      if (localReservations[i].id === id) {
        localReservations.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  // Reserves the chat-a/chat-b seat pair atomically and plans a real waypoint
  // route for BOTH employees from their current nodes (never a teleport).
  // Any single failure — unreachable leg or seat reservation — cancels the
  // whole pair and leaves no partial reservation behind.
  function beginChat({ employeeId, partnerId, fromNodeId, partnerNodeId, nowMs, externalReservations = [] } = {}) {
    if (activeChatPair) return fail('CHAT_PAIR_EXISTS');
    if (!employees.has(employeeId) || !employees.has(partnerId) || employeeId === partnerId) {
      return fail('CHAT_PARTNERS_INVALID');
    }
    // M4.1g: a napping resident never joins a conversation — the pair would
    // overwrite the nap cycle (no wake, no sleep-ended log) and die on the next
    // tick. The guard also covers direct beginChat calls outside the director.
    for (const id of [employeeId, partnerId]) {
      const current = employees.get(id).current;
      if (current && current.activity === 'sleeping') return fail('CHAT_PARTNERS_UNAVAILABLE', { employeeId: id });
    }
    const seats = chatSeatNodes();
    if (seats.length < 2) return fail('CHAT_SEATS_UNAVAILABLE');
    const at = atOrDefault(nowMs);
    const all = allReservations(externalReservations);

    // Both legs are planned through the movement contract BEFORE any seat is
    // reserved: an unreachable leg means no chat and no reservation churn.
    const routeA =
      typeof fromNodeId === 'string' && nodesById.has(fromNodeId)
        ? movement.findRoute({
            fromNodeId,
            toNodeId: seats[0].id,
            behavior: 'chatting',
            reservations: all,
            nowMs: at,
            employeeId,
          })
        : null;
    const routeB =
      typeof partnerNodeId === 'string' && nodesById.has(partnerNodeId)
        ? movement.findRoute({
            fromNodeId: partnerNodeId,
            toNodeId: seats[1].id,
            behavior: 'chatting',
            reservations: all,
            nowMs: at,
            employeeId: partnerId,
          })
        : null;
    if (!Array.isArray(routeA) || !Array.isArray(routeB)) {
      return fail('CHAT_ROUTES_UNAVAILABLE', {
        initiatorReachable: Array.isArray(routeA),
        partnerReachable: Array.isArray(routeB),
      });
    }

    const seatA = movement.acquireReservation({
      employeeId,
      purpose: 'chatting',
      nodeId: seats[0].id,
      segments: [],
      reservations: all,
      nowMs: at,
      ttlMs: effectiveConfig.chatSeatTtlMs,
      safeRadius: seats[0].safeRadius,
    });
    if (!seatA.ok) return fail('CHAT_SEATS_UNAVAILABLE', { seat: seats[0].id });
    const seatB = movement.acquireReservation({
      employeeId: partnerId,
      purpose: 'chatting',
      nodeId: seats[1].id,
      segments: [],
      reservations: [...all, seatA.reservation],
      nowMs: at,
      ttlMs: effectiveConfig.chatSeatTtlMs,
      safeRadius: seats[1].safeRadius,
    });
    if (!seatB.ok) {
      removeLocalReservation(seatA.reservation.id);
      return fail('CHAT_SEATS_UNAVAILABLE', { seat: seats[1].id });
    }

    // Success: both employees leave their previous spots (release their local
    // reservations) and share one consistent chatting state.
    releaseEmployeeReservations(employeeId);
    releaseEmployeeReservations(partnerId);
    releaseLeftClaim(employeeId);
    releaseLeftClaim(partnerId);
    localReservations.push(seatA.reservation, seatB.reservation);
    activeChatPair = { a: employeeId, b: partnerId, startedAt: at, seatA: seats[0].id, seatB: seats[1].id };
    employees.get(employeeId).current = { activity: 'chatting', startedAt: at, nodeId: seats[0].id };
    employees.get(partnerId).current = { activity: 'chatting', startedAt: at, nodeId: seats[1].id };
    // M4.1g: the director's cooldowns must see BOTH pair members.
    director.note({ employeeId, activity: 'chatting', atMs: at });
    director.note({ employeeId: partnerId, activity: 'chatting', atMs: at });
    const facing = {
      [employeeId]: facingBetween(seats[0].position, seats[1].position),
      [partnerId]: facingBetween(seats[1].position, seats[0].position),
    };
    const presentation = Object.freeze({
      marker: 'chat-ellipsis',
      accessibleLabel: `${employees.get(employeeId).displayName} 与 ${employees.get(partnerId).displayName} 正在交流`,
    });
    const targets = Object.freeze({
      [employeeId]: Object.freeze({ nodeId: seats[0].id, route: Object.freeze([...routeA]) }),
      [partnerId]: Object.freeze({ nodeId: seats[1].id, route: Object.freeze([...routeB]) }),
    });
    return Object.freeze({
      ok: true,
      seats: Object.freeze([
        Object.freeze({ nodeId: seats[0].id, employeeId, reservation: seatA.reservation }),
        Object.freeze({ nodeId: seats[1].id, employeeId: partnerId, reservation: seatB.reservation }),
      ]),
      facing: Object.freeze(facing),
      targets,
      presentation,
      startedAt: at,
    });
  }

  function activeChatPairInfo() {
    return activeChatPair ? Object.freeze({ ...activeChatPair }) : null;
  }

  function endChat({ nowMs } = {}) {
    if (!activeChatPair) return fail('NO_ACTIVE_CHAT');
    const at = atOrDefault(nowMs);
    const pair = activeChatPair;
    releaseEmployeeReservations(pair.a);
    releaseEmployeeReservations(pair.b);
    employees.get(pair.a).cooldownUntil = at + effectiveConfig.chatCooldownMs;
    employees.get(pair.b).cooldownUntil = at + effectiveConfig.chatCooldownMs;
    employees.get(pair.a).current = null;
    employees.get(pair.b).current = null;
    activeChatPair = null;
    return Object.freeze({
      ok: true,
      employees: Object.freeze([pair.a, pair.b]),
      startedAt: pair.startedAt,
      endedAt: at,
    });
  }

  function evaluateSleep({ employeeId, nowMs, bindingActive = false, sync = 'healthy' } = {}) {
    const employee = employees.get(employeeId);
    if (!employee) return fail('UNKNOWN_EMPLOYEE', { employeeId: employeeId ?? null });
    const at = atOrDefault(nowMs);
    const threshold = effectiveConfig.sleepAfterMs;
    const blockers = [];
    const idleMs = employee.idleSince === null ? 0 : Math.max(0, at - employee.idleSince);
    if (employee.idleSince === null || idleMs < threshold) blockers.push('below-threshold');
    if (bindingActive) blockers.push('binding-active');
    if (sync !== 'healthy') blockers.push('sync');
    // M4.1g: a resident who just finished a nap stays awake for the refractory
    // window — otherwise the office reads as a nap carousel.
    if (employee.napRefractoryUntil > at) blockers.push('nap-refractory');
    return Object.freeze({
      employeeId,
      eligible: blockers.length === 0,
      idleMs,
      thresholdMs: threshold,
      blockers: Object.freeze(blockers),
    });
  }

  // M4.1g: the residents currently inside a nap (optionally excluding one).
  function sleepingEmployeeIds(exceptEmployeeId = null) {
    const out = [];
    for (const [employeeId, employee] of employees) {
      if (employeeId === exceptEmployeeId) continue;
      if (employee.current && employee.current.activity === 'sleeping') out.push(employeeId);
    }
    return out.sort();
  }

  // M4.1g: one nap lasts a fixed configured duration, or a seeded random draw
  // inside the configured range (default 60–180s). Deterministic per employee.
  function drawSleepDurationMs(employeeId) {
    const fixed = effectiveConfig.sleepDurationMs;
    if (typeof fixed === 'number' && Number.isFinite(fixed) && fixed > 0) return Math.round(fixed);
    const range = effectiveConfig.sleepDurationRangeMs || DEFAULT_SLEEP_DURATION_RANGE_MS;
    let minMs = Number.isFinite(range.minMs) ? range.minMs : DEFAULT_SLEEP_DURATION_RANGE_MS.minMs;
    let maxMs = Number.isFinite(range.maxMs) ? range.maxMs : DEFAULT_SLEEP_DURATION_RANGE_MS.maxMs;
    if (maxMs < minMs) {
      const swap = minMs;
      minMs = maxMs;
      maxMs = swap;
    }
    return Math.round(minMs + rngFor(employeeId)() * (maxMs - minMs));
  }

  function markTaskStarted({ employeeId, nowMs } = {}) {
    const employee = employees.get(employeeId);
    if (!employee) return fail('UNKNOWN_EMPLOYEE');
    employee.idleSince = null;
    return Object.freeze({ ok: true, employeeId });
  }

  function markTaskReleased({ employeeId, nowMs } = {}) {
    const employee = employees.get(employeeId);
    if (!employee) return fail('UNKNOWN_EMPLOYEE');
    employee.idleSince = atOrDefault(nowMs);
    employee.current = null;
    return Object.freeze({ ok: true, employeeId });
  }

  // Routes through the movement controller's waypoint/reservation contract;
  // picks same-tag candidates in a seeded deterministic order and NEVER
  // teleports: no reachable, reservable candidate => null (the caller waits).
  // Every point a peer occupies NOW or is WALKING TO (a reserved destination is
  // where the body will be in a moment).
  function peerExclusionPoints(peers) {
    const points = [];
    if (!Array.isArray(peers)) return points;
    for (const peer of peers) {
      if (!peer) continue;
      if (peer.position) points.push(peer.position);
      const target = peer.targetNodeId ? nodesById.get(peer.targetNodeId) : null;
      if (target) points.push(target.position);
    }
    return points;
  }

  // Nodes a peer BODY stands on now or is walking TO. Routes must not pass
  // through them (a capacity-2 node holds the reservation but the body blocks
  // the step — see movement.findRoute).
  // M4.1h: the rule is now "where the body IS or WILL BE", not "both ends of
  // its walk". A mid-leg walker's currentNodeId is the node it just LEFT (its
  // body is on the segment, guarded separately by the movement controller's
  // occupant gate), so blocking it for every other planner was over-conservative
  // and measurably stranding the left wing: five bodies walking kept claiming
  // their origin nodes and the wing's gateways read as permanently occupied.
  function occupiedFromPeers(peers) {
    const occupied = new Set();
    if (!Array.isArray(peers)) return occupied;
    for (const peer of peers) {
      if (!peer) continue;
      if (typeof peer.targetNodeId === 'string' && peer.targetNodeId) {
        occupied.add(peer.targetNodeId);
        continue;
      }
      if (typeof peer.currentNodeId === 'string' && peer.currentNodeId) occupied.add(peer.currentNodeId);
    }
    return occupied;
  }

  function isCrowded(node, peers) {
    if (!node || !node.position) return false;
    const points = peerExclusionPoints(peers);
    if (points.length === 0) return false;
    return points.some((point) => Math.hypot(
      node.position.x - point.x,
      node.position.y - point.y
    ) < PERSONAL_SPACE_RATIO);
  }

  // Plans one candidate list through the movement contract, in order, and
  // returns the first (nodeId, route, reservation) that both routes AND
  // reserves. `null` when nothing in the list is reachable/reservable NOW.
  function planFirstReachable({ employeeId, behavior, fromNodeId, at, externalReservations, candidateIds, peers, priority = false }) {
    const all = allReservations(externalReservations);
    for (const nodeId of candidateIds) {
      const route = movement.findRoute({
        fromNodeId,
        toNodeId: nodeId,
        behavior,
        reservations: all,
        nowMs: at,
        employeeId,
        occupiedNodeIds: occupiedFromPeers(peers),
        priority,
      });
      if (!Array.isArray(route)) continue;
      const node = nodesById.get(nodeId);
      const acquired = movement.acquireReservation({
        employeeId,
        purpose: behavior,
        nodeId,
        segments: [],
        reservations: all,
        nowMs: at,
        ttlMs: knob('reservationTtlMs'),
        safeRadius: node ? node.safeRadius : 0.02,
      });
      if (!acquired.ok) continue;
      localReservations.push(acquired.reservation);
      return { nodeId, route: [...route], reservation: acquired.reservation };
    }
    return null;
  }

  // Keep-away ordering: spacious candidates first (same seeded order inside
  // each group), crowded ones kept as the liveness fallback.
  function keepAwayOrder(candidateIds, peers) {
    const spacious = [];
    const crowded = [];
    for (const nodeId of candidateIds) {
      (isCrowded(nodesById.get(nodeId), peers) ? crowded : spacious).push(nodeId);
    }
    return [...spacious, ...crowded];
  }

  // M4.1h "路径加每趟微偏移": with a seeded chance the direct route is replaced
  // by a two-leg route through ONE extra waypoint — every leg is still planned
  // through movement.findRoute with the live reservations/occupancy, so a
  // detour can never invent an off-graph or occupied step. Only the path shape
  // changes; the reserved target is untouched.
  function maybeDetour({ route, targetNodeId, employeeId, behavior, fromNodeId, at, externalReservations, peers, priority = false }) {
    const chance = knob('detourChance') * personalityScale(employeeId, 'curiosity');
    if (!(chance > 0) || !Array.isArray(route) || route.length < 3) return route;
    if (rngFor(employeeId)() >= chance) return route;
    const onRoute = new Set(route);
    const mids = shuffled(
      graph.nodes
        .filter((node) => node && Array.isArray(node.tags) && node.tags.includes(behavior)
          && node.id !== fromNodeId && node.id !== targetNodeId && !onRoute.has(node.id)
          && !node.id.startsWith('desk-'))
        .map((node) => node.id),
      rngFor(employeeId)
    );
    const all = allReservations(externalReservations);
    const occupied = occupiedFromPeers(peers);
    for (const midId of mids) {
      const legA = movement.findRoute({ fromNodeId, toNodeId: midId, behavior, reservations: all, nowMs: at, employeeId, occupiedNodeIds: occupied, priority });
      if (!Array.isArray(legA)) continue;
      const legB = movement.findRoute({ fromNodeId: midId, toNodeId: targetNodeId, behavior, reservations: all, nowMs: at, employeeId, occupiedNodeIds: occupied, priority });
      if (!Array.isArray(legB)) continue;
      return [...legA, ...legB.slice(1)];
    }
    return route;
  }

  function personalityScale(employeeId, trait) {
    if (!knob('personality')) return 1;
    const personality = director.personality({ employeeId });
    return personality && Number.isFinite(personality[trait]) ? personality[trait] : 1;
  }

  // M4.1h: how long the CURRENT local activity must last before it is
  // re-decided. Neutral activities keep minDwellMs; a long break at a
  // rest-area node carries its own longer dwell.
  function dwellFor(current) {
    return current && Number.isFinite(current.dwellMs) && current.dwellMs > 0
      ? current.dwellMs
      : knob('minDwellMs');
  }

  function chooseTarget({ employeeId, behavior, fromNodeId, at, externalReservations, preferredNodeId, peers = [], candidateIds = null, priority = false }) {
    let candidates;
    if (behavior === 'sleeping') {
      candidates = preferredNodeId && nodesById.has(preferredNodeId) ? [preferredNodeId] : [];
    } else if (Array.isArray(candidateIds)) {
      // an explicit pool is still subject to the universal "never target where
      // you already stand" rule (findRoute would happily return [fromNodeId]).
      candidates = candidateIds.filter((nodeId) => nodeId !== fromNodeId);
    } else {
      candidates = graph.nodes
        .filter((node) => Array.isArray(node.tags) && node.tags.includes(behavior) && node.id !== fromNodeId)
        // M4.1b: roaming never targets the roaming-tagged desk-*-leave nodes —
        // they made walkers wander to other people's workstations (reads as
        // "串工位"); every other roaming-tagged spot stays eligible.
        .filter((node) => (behavior === 'roaming' ? !node.id.startsWith('desk-') : true))
        .map((node) => node.id);
      // M4.1g: the left rest area joins the roaming pool. Layouts that declare
      // it (rest-area/lounge/left-wing tags) contribute those nodes even
      // without the roaming tag; otherwise the geometric left of the corridor
      // ring is used (see idle-director.resolveLeftAreaNodeIds).
      if (behavior === 'roaming' && leftAreaNodeIds.length > 0) {
        for (const nodeId of leftAreaNodeIds) {
          if (!candidates.includes(nodeId) && nodesById.has(nodeId) && nodeId !== fromNodeId) {
            candidates.push(nodeId);
          }
        }
      }
    }
    candidates = shuffled(candidates, rngFor(employeeId));
    if (behavior !== 'sleeping') candidates = keepAwayOrder(candidates, peers);
    // M4.1h 反乒乓: never walk straight back to the node just left when any other
    // candidate exists. The hottest node PAIR in the assessment was always an
    // adjacent ping-pong (A→B→A→B every ~80s); demoting the previous target to
    // the end of the list removes the oscillation without ever blocking a walk.
    // Only a node ALREADY in this candidate list is demoted — appending a node
    // from outside the list would smuggle a right-side target into the left
    // preference's pool (measured: exactly that produced same-decision
    // reversals after the first cut of this rule).
    const employee = employees.get(employeeId);
    const lastTarget = employee && employee.lastTargetNodeId;
    if (lastTarget && candidates.length > 1 && candidates.includes(lastTarget) && candidates[0] !== lastTarget) {
      candidates = [...candidates.filter((nodeId) => nodeId !== lastTarget), lastTarget];
    }

    const chosen = planFirstReachable({ employeeId, behavior, fromNodeId, at, externalReservations, candidateIds: candidates, peers, priority });
    if (!chosen) return null;
    if (employee) employee.lastTargetNodeId = chosen.nodeId;
    if (behavior === 'roaming') {
      chosen.route = maybeDetour({
        route: chosen.route,
        targetNodeId: chosen.nodeId,
        employeeId,
        behavior,
        fromNodeId,
        at,
        externalReservations,
        peers,
        priority,
      });
    }
    return chosen;
  }

  // M4.1h fairness governor. Every roaming decision an employee makes is
  // recorded with whether it targeted the left area; a walker whose recent
  // decisions were already mostly leftward stops drawing the left preference
  // until the window slides. Deterministic (no clock beyond `at`), O(window).
  function noteRoamingDecision(employee, at, left) {
    if (!employee) return;
    const ring = employee.roamDecisions || (employee.roamDecisions = []);
    ring.push({ at, left });
    while (ring.length > 40) ring.shift();
    const windowMs = knob('leftFairnessWindowMs');
    const recent = ring.filter((entry) => at - entry.at <= windowMs);
    if (recent.length !== ring.length) employee.roamDecisions = recent;
  }

  function leftFairnessStandDown(employee, at) {
    if (!employee) return false;
    const ring = (employee.roamDecisions || []).filter((entry) => at - entry.at <= knob('leftFairnessWindowMs'));
    if (ring.length < knob('leftFairnessMinDecisions')) return false;
    const leftShare = ring.filter((entry) => entry.left).length / ring.length;
    return leftShare >= knob('leftFairnessMaxShare');
  }

  // ---- M4.1h r2 per-employee left-time budget -------------------------------
  // Integrate ONE interval (the time since this employee's previous decision)
  // into the decayed accountant, then re-arm for the next interval. The
  // interval's left-ness is the trapezoid of "was the previous decision's
  // roaming state in the left half" and "is the current node in the left half"
  // (the module reports `fromNodeId` = nearest node to the body on every call,
  // so consecutive samples bracket a leg). Only ROAMING time is accounted —
  // the user metric is "share of ROAMING time in the left half".
  function settleLeftQuota(employee, at, fromNodeId) {
    if (!employee) return;
    const nowLeft = typeof fromNodeId === 'string' && leftHalfNodeIdSet.has(fromNodeId);
    if (employee.quotaAtMs !== null) {
      const dt = at - employee.quotaAtMs;
      if (dt > 0) {
        const windowMs = knob('leftQuotaWindowMs');
        const decay = windowMs > 0 ? Math.exp(-dt / windowMs) : 0;
        employee.quotaRoamMs *= decay;
        employee.quotaLeftMs *= decay;
        if (employee.quotaWasRoaming) {
          const fraction = (employee.quotaWasLeft ? 0.5 : 0) + (nowLeft ? 0.5 : 0);
          employee.quotaRoamMs += dt;
          employee.quotaLeftMs += dt * fraction;
        }
      }
    }
    employee.quotaAtMs = at;
    employee.quotaWasRoaming = !!(employee.current && employee.current.activity === 'roaming');
    employee.quotaWasLeft = nowLeft;
  }

  function leftQuotaActive() {
    return knob('leftQuotaEnabled') !== false && leftHalfNodeIdSet.size > 0;
  }

  function leftQuotaShare(employee) {
    if (!employee || !leftQuotaActive()) return null;
    if (employee.quotaRoamMs < knob('leftQuotaMinRoamMs')) return null;
    return employee.quotaLeftMs / employee.quotaRoamMs;
  }

  // The office-wide accountant, for the aggregate servo. Null until the whole
  // roster has enough roaming time to make the ratio meaningful.
  function officeLeftQuotaShare() {
    if (!leftQuotaActive()) return null;
    let roam = 0;
    let left = 0;
    for (const employee of employees.values()) {
      roam += employee.quotaRoamMs;
      left += employee.quotaLeftMs;
    }
    const minimum = knob('leftQuotaMinRoamMs') * Math.max(1, employees.size);
    if (roam < minimum) return null;
    return roam > 0 ? left / roam : null;
  }

  // ---- M4.1h r2 fair lane ----------------------------------------------------
  // One under-served walker at a time owns the wing. The claim is granted when
  // an under-served walker actually picks a left target and released the moment
  // that walker is no longer roaming inside the left half (its next roaming
  // decision targets the right, or it rests/chats/sleeps/is interrupted).
  // `leftClaimExpiresMs` is a safety TTL for a claimant that gets stuck.
  let leftClaim = null; // { employeeId, untilMs, lastFromNodeId }
  function currentLeftClaim(at) {
    if (leftClaim && (leftClaim.untilMs <= at || !employees.has(leftClaim.employeeId))) leftClaim = null;
    return leftClaim;
  }
  function grantLeftClaim(employeeId, at) {
    leftClaim = { employeeId, untilMs: at + knob('leftQuotaClaimTtlMs'), lastFromNodeId: null };
  }
  function releaseLeftClaim(employeeId) {
    if (leftClaim && (employeeId === undefined || leftClaim.employeeId === employeeId)) leftClaim = null;
  }

  // M4.1h r3 observability: why left draws were skipped, office-wide and per
  // employee. Read-only; the headless harness uses it to localize the 0.000
  // employees. Never consulted by behavior.
  const leftDebug = { skip: {}, emp: {}, targets: {} };

  // M4.1h probabilistic left target selection. The walker draws ONCE per
  // roaming decision: with `leftRoamBias` (default 0.4) it must target the left
  // rest area. If every left candidate is blocked the SAME decision must not
  // turn the walk around (the old silent re-route) — it returns a wait and
  // retries after the patience budget, and only a LATER decision may stand down
  // to the general pool. Returns:
  //   { target }                        — a planned left target
  //   { blocked: 'left' }               — wait, retry (patience left)
  //   { blocked: 'left-standdown' }     — wait; the NEXT decision picks freely
  //   { skipped: true }                 — no left preference this decision
  function planRoamingTarget({ employeeId, fromNodeId, at, externalReservations, peers }) {
    const employee = employees.get(employeeId);
    const leftSet = new Set(leftAreaNodeIds);
    if (!employee) return { skipped: true };
    const alreadyLeft = typeof fromNodeId === 'string'
      && (leftSet.has(fromNodeId) || (leftQuotaActive() && leftHalfNodeIdSet.has(fromNodeId)));
    const peersInLeft = (Array.isArray(peers) ? peers : [])
      .filter((peer) => peer && peer.position && peer.position.x < 0.5).length;
    // M4.1h r2: the per-employee budget decides HOW HARD this walker draws.
    //  * share > ceiling -> the draw is TAPERED (probability falls linearly to
    //    0 at share 1) instead of cutting the walker out of the wing entirely.
    //    Measured: a hard stand-down cost 0.08 of pooled share (0.445 -> 0.363
    //    over 11 seeds) and did NOT improve the per-employee band, because the
    //    wing simply emptied when the high-share walkers stopped visiting.
    //  * share < floor -> the walker is ENTITLED to a turn (see the fair lane).
    const share = leftQuotaShare(employee);
    const officeShare = officeLeftQuotaShare();
    const aboveCeiling = share !== null && share > knob('leftQuotaCeiling');
    const belowFloor = share !== null && share < knob('leftQuotaFloor');
    const ceilingActive = officeShare === null || officeShare > knob('leftQuotaAggregateFloor');
    // Taper factor in [0,1]: 1 at/below the ceiling, 0 at share 1. 0 when the
    // draw is suspended (office under-served is the opposite case).
    const taper = aboveCeiling && ceilingActive
      ? Math.max(0, Math.min(1, (1 - share) / Math.max(1e-6, 1 - knob('leftQuotaCeiling'))))
      : 1;
    // M4.1h r2 fair lane: the losers never enter the wing at all (measured:
    // 0 left-half roaming runs in 30 min against 24-33 for the winners, and an
    // under-served walker was blocked ~14 decisions per left intent while
    // in-band walkers kept entering), so a boosted draw alone only camps the
    // entrance. The wing is handed to ONE under-served walker at a time: a
    // walker that actually WINS the wing holds the lane until it leaves the
    // left half, and while it does, the other UNDER-SERVED walkers wait their
    // turn instead of piling up at the gateway. In-band walkers keep their
    // normal draw so the wing stays populated (measured: excluding everyone
    // but the claimant collapsed the pooled share to 0.30).
    const claim = currentLeftClaim(at);
    const isClaimant = !!claim && claim.employeeId === employeeId;
    const claimActive = !!claim;
    // The claimant's live position (the scheduler is told the nearest node to
    // its body on every decide call) — the lane only QUEUES others once that
    // body is actually inside the wing.
    if (isClaimant && typeof fromNodeId === 'string') claim.lastFromNodeId = fromNodeId;
    // M4.1h r3: queue the other under-served walkers only while the claimant is
    // actually INSIDE the wing (holding it). Measured: the old rule excluded
    // them from the very moment the claim was granted — while the claimant was
    // still walking in from the right half — and one claimant camping the wing
    // starved another under-served walker for 330 decisions (a 0.000 employee),
    // even though the wing itself was not the constraint.
    const claimInside = !!claim && typeof claim.lastFromNodeId === 'string'
      && leftHalfNodeIdSet.has(claim.lastFromNodeId);
    const quotaStandDown = claimActive && !isClaimant && belowFloor && claimInside;
    // Observability (M4.1h r3): which gate stopped this draw. Integer bumps in a
    // rarely-taken branch only; used by the headless harness to prove WHERE the
    // 0.000-left employees are being held, instead of guessing.
    let skipReason = null;
    const gate = (ok, name) => { if (!ok && skipReason === null) skipReason = name; return ok; };
    // M4.1h r3: the decision-count throttle is the anti-CAMPING brake for
    // walkers who already hold the wing. Measured: it also caught under-served
    // walkers whose left DECISIONS were marked left but whose walks never
    // completed (blocked/replanned), so they were throttled while their left
    // TIME stayed 0.000 — the floor requirement. A below-floor walker is
    // entitled by budget, so the throttle does not apply to it.
    const decisionCountThrottle = !belowFloor && leftFairnessStandDown(employee, at);
    const usePreference = gate(leftPreferenceOn, 'no-preference')
      && gate(leftAreaNodeIds.length > 0, 'no-left-pool')
      && gate(knob('leftRoamBias') > 0, 'bias-off')
      && gate(!employee.leftStandDownOnce, 'stand-down-once')
      && gate(!alreadyLeft, 'already-left')
      && gate(employee.leftCooldownUntilMs <= at, 'visit-cooldown')
      // M4.1h r3: the crowd cap exists so the office does not pile everyone
      // into the wing, but it must not LOCK OUT the under-served — measured:
      // with the wing kept full by the corridor priority, the crowd cap made an
      // under-served walker skip the draw on every decision and finish a 30-min
      // window with 0.000 left time (the individual floor the user reported).
      // An under-served walker may draw even when the wing is at the cap.
      && gate(peersInLeft < knob('leftCrowdLimit') || belowFloor, 'crowd-cap')
      // M4.1h r2: the legacy decision-count fairness stays as the anti-camping
      // brake. Removing it let the under-served catch-up draw fire on nearly
      // every decision (measured: pooled share fell to 0.389) — the budget is
      // the ENTITLEMENT, the decision-count rule is the THROTTLE.
      && gate(!decisionCountThrottle, 'decision-count-fairness')
      && gate(!quotaStandDown, 'lane-queue')
      && gate(leftAreaNodeIds.some((nodeId) => nodeId !== fromNodeId), 'standing-on-last-left-target');
    if (skipReason !== null) {
      leftDebug.skip[skipReason] = (leftDebug.skip[skipReason] || 0) + 1;
      const perEmp = leftDebug.emp[employeeId] || (leftDebug.emp[employeeId] = {});
      perEmp[skipReason] = (perEmp[skipReason] || 0) + 1;
    }
    if (!usePreference) {
      employee.leftStandDownOnce = false;
      if (quotaStandDown) {
        // The wing is currently on loan to an under-served walker: hold every
        // other walker out of the left pool for this decision, not merely out
        // of the preference draw.
        noteRoamingDecision(employee, at, false);
        return { skipped: true, excludeLeft: true, quota: 'lane' };
      }
      return { skipped: true };
    }
    employee.leftStandDownOnce = false;
    // An under-served walker is ENTITLED to the wing (a high catch-up draw);
    // everyone else keeps the livelier probabilistic preference, TAPERED by the
    // over-ceiling factor. The extra draw is taken ONLY when the taper actually
    // bites (taper < 1), so the default (no ceiling) consumes exactly the same
    // rng stream as the pre-r2 build and the trajectory is unchanged.
    const preferLeft = belowFloor
      ? rngFor(employeeId)() < knob('leftQuotaCatchUpChance')
      : (director.prefersLeftArea({ employeeId })
        && (taper >= 1 || rngFor(employeeId)() < taper));
    if (!preferLeft) {
      noteRoamingDecision(employee, at, false);
      return { skipped: true };
    }

    const leftCandidates = leftAreaNodeIds.filter((nodeId) => nodeId !== fromNodeId && nodesById.has(nodeId));
    // M4.1e keeps its meaning INSIDE the left group: chooseTarget orders the
    // left pool spacious-first, so the preference walks to a free spot whenever
    // one exists. (An earlier M4.1h cut also DEFERRED the whole left intent when
    // every left spot was merely crowded, with a spacious right-side spot
    // available — measured: it pushed the pooled left-half share from 0.44 to
    // 0.40 and one seed down to 0.23, because a single peer walking the narrow
    // left aisle marks most of the column crowded. The personal-space promise is
    // pinned where it belongs: every NON-left draw and every choice inside the
    // left group.)
    // M4.1h r3: corridor passage priority, graded (see movement.findRoute).
    // Every left intent plans at level 1 (it may route past a parked body, so
    // one peer on the wing's first chain node no longer makes the whole wing
    // read "unreachable"). The under-served walker the user named (below its
    // floor, or holding the fair lane) plans at level 2, which also ignores a
    // MOVING peer's route — the runtime gate + mission patience make that peer
    // yield. `leftCorridorPriorityAll` widens level 2 to every left intent;
    // DEFAULT false (measured 0.516 pooled share, chat bubbles halved).
    const corridorPriority = knob('leftCorridorPriority') === false
      ? 0
      : (belowFloor || isClaimant || knob('leftCorridorPriorityAll') === true ? 2 : 1);
    const target = chooseTarget({
      employeeId,
      behavior: 'roaming',
      fromNodeId,
      at,
      externalReservations,
      peers,
      candidateIds: leftCandidates,
      priority: corridorPriority,
    });
    if (target) {
      employee.leftBlockedStreak = 0;
      employee.leftCooldownUntilMs = at + knob('leftAfterVisitCooldownMs');
      noteRoamingDecision(employee, at, true);
      // An under-served walker that actually won the wing holds the fair lane
      // until it leaves the left half (or the TTL expires).
      if (belowFloor) grantLeftClaim(employeeId, at);
      return { target, left: true, containedLeft: leftSet.has(target.nodeId), corridorPriority };
    }
    // Every left candidate is blocked RIGHT NOW. Wait instead of reversing.
    noteRoamingDecision(employee, at, false);
    employee.leftBlockedStreak += 1;
    if (employee.leftBlockedStreak > knob('leftRetryAttempts')) {
      employee.leftBlockedStreak = 0;
      employee.leftStandDownOnce = true;
      return { blocked: 'left-standdown' };
    }
    return { blocked: 'left' };
  }

  function decide(request) {
    const {
      employeeId,
      nowMs,
      fromNodeId = null,
      bindingActive = false,
      sync = 'healthy',
      forceActivity = null,
      chatCandidates = [],
      externalReservations = [],
      peers = [],
      enRoute = false,
      arrivedNodeId = null,
    } = request || {};
    const employee = employees.get(employeeId);
    if (!employee) return fail('UNKNOWN_EMPLOYEE', { employeeId: employeeId ?? null });
    const at = atOrDefault(nowMs);
    // M4.1h r2: fold the interval that just elapsed into this resident's
    // left-time budget BEFORE any early return (the budget must see every tick,
    // including the long 'continue' holds — that is exactly the time it is
    // accounting for).
    settleLeftQuota(employee, at, fromNodeId);
    let current = employee.current;

    // Members of the active chat pair stay inside it until endChat or
    // interruptForTask: re-deciding must never replace reservations, wander
    // off into roaming/resting, or break the pair.
    if (activeChatPair && (activeChatPair.a === employeeId || activeChatPair.b === employeeId)) {
      const isInitiator = activeChatPair.a === employeeId;
      return Object.freeze({
        ok: true,
        employeeId,
        activity: 'continue',
        decidedAt: at,
        current: Object.freeze({ activity: 'chatting', startedAt: activeChatPair.startedAt }),
        chat: Object.freeze({
          partnerId: isInitiator ? activeChatPair.b : activeChatPair.a,
          seatNodeId: isInitiator ? activeChatPair.seatA : activeChatPair.seatB,
          marker: 'chat-ellipsis',
        }),
      });
    }

    // M4.1g: a FINISHED nap wakes the sleeper — no local state is permanent.
    // The wake happens exactly once (the nap cycle's startedAt is consumed
    // here) and the resident falls through to the normal activity roll below.
    let wokeFromSleep = null;
    if (current && current.activity === 'sleeping') {
      const wakeAtMs = Number.isFinite(current.wakeAtMs) ? current.wakeAtMs : Infinity;
      if (at >= wakeAtMs) {
        const startedAt = current.startedAt;
        releaseEmployeeReservations(employeeId);
        employee.current = null;
        employee.napRefractoryUntil = at + effectiveConfig.sleepRefractoryMs;
        wokeFromSleep = Object.freeze({
          startedAt,
          endedAt: at,
          sleptMs: Math.max(0, at - startedAt),
          nodeId: current.nodeId ?? null,
        });
        current = null;
      }
    }

    // SPEC-04 decision points: "抵达目标 ..." — arriving at the chosen target
    // restarts the dwell there, so a completed walk parks the body at the
    // target for the minimum dwell before the next decision. Without this the
    // walk finished and the very next tick re-rolled, so nobody ever dwelled
    // at a waypoint.
    if (arrivedNodeId && current && current.nodeId === arrivedNodeId
        && at - current.startedAt >= effectiveConfig.minDwellMs) {
      current.startedAt = at;
    }

    // Minimum dwell: an ongoing local activity is not re-decided. M4.1h: a
    // decision may carry its own `dwellMs` (a rest-area break lasts longer than
    // the plain minimum) — the neutral case stays exactly minDwellMs.
    if (current && current.activity && at - current.startedAt < dwellFor(current)) {
      return Object.freeze({
        ok: true,
        employeeId,
        activity: 'continue',
        decidedAt: at,
        current: Object.freeze({ activity: current.activity, startedAt: current.startedAt }),
      });
    }

    // M4.1b (documented intent, finally wired): a ROAMING walker that is still
    // on its route keeps its target until arrival — the module reports
    // `enRoute`. Re-deciding mid-walk every dwell window re-planned long walks
    // before they could finish, so distant targets (the left rest area behind
    // its corridor gateway, ~10s of walking) were never reached. A blocked
    // walker is NOT protected: the module drops the route through the
    // M4.1e patience ladder (yield / self-replan), which clears `enRoute` and
    // the next decision re-plans against the current reservations.
    if (current && current.activity === 'roaming' && enRoute === true) {
      return Object.freeze({
        ok: true,
        employeeId,
        activity: 'continue',
        decidedAt: at,
        current: Object.freeze({ activity: 'roaming', startedAt: current.startedAt }),
      });
    }

    // M4.1g: an UNFINISHED nap continues — it never restarts a fresh cycle.
    // The old code re-entered sleeping every dwell window (fresh startedAt,
    // fresh "开始小憩" log line), which is what froze five employees at their
    // desks forever.
    if (current && current.activity === 'sleeping') {
      return Object.freeze({
        ok: true,
        employeeId,
        activity: 'continue',
        decidedAt: at,
        current: Object.freeze({ activity: 'sleeping', startedAt: current.startedAt }),
        sleepEvent: Object.freeze({
          phase: 'continuing',
          startedAt: current.startedAt,
          wakeAtMs: current.wakeAtMs ?? null,
          remainingMs: Number.isFinite(current.wakeAtMs) ? Math.max(0, current.wakeAtMs - at) : null,
        }),
      });
    }

    // Sleep gate: threshold + no unfinished binding + healthy sync + the
    // post-nap refractory + the M4.1g concurrency cap (at most maxSleepers
    // residents nap at once; the next one keeps roaming/resting/chatting).
    // The decision that ENDS a nap never starts the next one in the same
    // breath: the wake is always reported as a local-activity decision.
    const sleepCheck = evaluateSleep({ employeeId, nowMs: at, bindingActive, sync });
    if (!wokeFromSleep && sleepCheck.eligible && sleepingEmployeeIds(employeeId).length < effectiveConfig.maxSleepers) {
      releaseEmployeeReservations(employeeId);
      releaseLeftClaim(employeeId);
      const target = chooseTarget({
        employeeId,
        behavior: 'sleeping',
        fromNodeId,
        at,
        externalReservations,
        preferredNodeId: employee.defaultSeat,
      });
      // M4.1b (2026-09-17): sleeping ONLY at the own desk (decision 23). The
      // old fallback slept IN PLACE wherever the employee stood — a sleeper
      // parked mid-corridor is effectively an immovable body that blocks task
      // routes (the occupant gate rightly refuses to walk through it, and
      // wakes cannot move it because the sleep gate re-sleeps it in place).
      // When the desk is unreachable the employee simply stays awake and the
      // normal activity roll takes over.
      const atOwnDesk = typeof fromNodeId === 'string' && employee.defaultSeat === fromNodeId;
      if (target || atOwnDesk) {
        // M4.1g: one nap = one finite cycle with its own wake deadline.
        const durationMs = drawSleepDurationMs(employeeId);
        const wakeAtMs = at + durationMs;
        employee.current = {
          activity: 'sleeping',
          startedAt: at,
          nodeId: target ? target.nodeId : fromNodeId,
          wakeAtMs,
          durationMs,
        };
        return Object.freeze({
          ok: true,
          employeeId,
          activity: 'sleeping',
          decidedAt: at,
          reason: 'sleep-threshold',
          target: target ? Object.freeze({ nodeId: target.nodeId, route: Object.freeze(target.route) }) : null,
          wait: target ? null : Object.freeze({ waitMs: effectiveConfig.waitMs, reason: 'sleep-desk-unavailable' }),
          marker: Object.freeze({ kind: 'sleep-zzz', accessibleLabel: `${employee.displayName} 正在小憩` }),
          sleepEvent: Object.freeze({ phase: 'started', startedAt: at, wakeAtMs, durationMs }),
        });
      }
      // fall through: desk unreachable and not standing at it — stay awake
    }

    return rollLocalActivity({
      employee,
      employeeId,
      at,
      fromNodeId,
      forceActivity,
      chatCandidates,
      externalReservations,
      peers,
      wokeFromSleep,
    });
  }

  // The awake roll: idle-director pick (or a forced activity), the chat-craving
  // override, then the chatting/resting/roaming branches. Every returned
  // decision carries `wokeFromSleep` when this decision is the wake itself, so
  // the module can log exactly one "醒来" fact per nap.
  function rollLocalActivity({
    employee,
    employeeId,
    at,
    fromNodeId,
    forceActivity,
    chatCandidates,
    externalReservations,
    peers,
    wokeFromSleep,
  }) {
    const wakeFact = wokeFromSleep ? Object.freeze({ wokeFromSleep }) : null;

    // A forced sleeping request that is blocked falls back to staying awake.
    let roll = forceActivity && forceActivity !== 'sleeping' ? forceActivity : director.choose({ employeeId, atMs: at }).activity;
    // M4.1d follow-up (2026-09-18, user: "never see two residents chat"): the
    // plain 15% roll produced one pair per ~10-15 SIMULATED minutes — the
    // office reads as silent. A resident idle for a while with no pair active
    // now actively craves a chat: the chat branch is tried first (every real
    // gate still applies — eligibility, seating, reservations — nothing is
    // faked). ~one pair every 1.5-3 minutes in measurement.
    if (roll !== 'chatting' && !activeChatPair && employee.idleSince !== null
        && at - employee.idleSince >= CHAT_CRAVE_AFTER_MS && rngFor(employeeId)() < 0.5) {
      roll = 'chatting';
    }
    const reasonPrefix = forceActivity && forceActivity !== 'sleeping' ? 'forced' : 'probability';

    // Chatting: pick the nearest eligible partner (distance-based, with the
    // documented tie-break); without one, fall through to roaming.
    if (roll === 'chatting') {
      const partner = chooseChatPartner({ employeeId, at, candidates: chatCandidates, fromNodeId });
      if (partner) {
        const pair = beginChat({
          employeeId,
          partnerId: partner.employeeId,
          fromNodeId,
          partnerNodeId: partner.nodeId,
          nowMs: at,
          externalReservations,
        });
        if (pair.ok) {
          const seat = pair.seats.find((entry) => entry.employeeId === employeeId);
          return Object.freeze({
            ok: true,
            employeeId,
            activity: 'chatting',
            decidedAt: at,
            reason: 'probability',
            target: Object.freeze({ nodeId: seat.nodeId, route: pair.targets[employeeId].route }),
            chat: Object.freeze({
              partnerId: partner.employeeId,
              seats: pair.seats,
              facing: pair.facing,
              targets: pair.targets,
              marker: pair.presentation.marker,
              accessibleLabel: pair.presentation.accessibleLabel,
            }),
            marker: pair.presentation,
            ...(wakeFact || {}),
          });
        }
      }
    }

    // Resting is a real behavior: it targets a resting-tagged waypoint through
    // the movement contract. Without a reachable resting waypoint it stays
    // resting and waits briefly — it never degrades to roaming or teleports.
    // Task E4: resting IN PLACE keeps the current node reserved — releasing
    // the reservation while still standing there let another roamer legally
    // park on the same cell (real-shell walkthrough found distance-0
    // co-location). The reacquire is best-effort: an occupied spot cannot be
    // evicted, and a non-node position simply rests unreserved as before.
    if (roll === 'resting') {
      releaseEmployeeReservations(employeeId);
      releaseLeftClaim(employeeId);
      // M4.1h: the rest AREA (left wing, beside the furniture band) is the
      // attractive place to rest — but resting does NOT require walking there:
      // a seeded share of resting picks walks to a rest-area spot, the rest
      // rests wherever they already are (own desk included), and a reachable
      // non-area resting waypoint is still preferred over standing in a crowd.
      const preferArea = restAreaNodeIdSet.size > 0
        && rngFor(employeeId)() < Math.min(1, Math.max(0, knob('restAreaAttraction') * personalityScale(employeeId, 'restfulness')));
      let target = preferArea
        ? chooseTarget({
            employeeId,
            behavior: 'resting',
            fromNodeId,
            at,
            externalReservations,
            peers,
            candidateIds: [...restAreaNodeIdSet].filter((nodeId) => nodeId !== fromNodeId),
          })
        : null;
      let restedInArea = !!(target && restAreaNodeIdSet.has(target.nodeId));
      if (!target) {
        target = chooseTarget({ employeeId, behavior: 'resting', fromNodeId, at, externalReservations, peers });
        restedInArea = !!(target && restAreaNodeIdSet.has(target.nodeId));
      }
      // M4.1e: on a layout without resting-tagged waypoints (the isometric
      // canonical fixture) resting still means "stay where I am". A crowded spot
      // (a peer within personal space) makes that read as two characters
      // standing on top of each other — walk to a quiet roaming spot instead,
      // and only rest in place when even that is unavailable.
      let movedForSpace = false;
      if (!target && isCrowded(nodesById.get(fromNodeId), peers)) {
        const quiet = chooseTarget({ employeeId, behavior: 'roaming', fromNodeId, at, externalReservations, peers });
        if (quiet) {
          target = quiet;
          movedForSpace = true;
        }
      }
      const eviction = evictions.get(employeeId);
      const evictedHere = !!(eviction && eviction.nodeId === fromNodeId && at < eviction.until);
      if (evictedHere) evictions.delete(employeeId);
      if (!target && !evictedHere && typeof fromNodeId === 'string' && nodesById.has(fromNodeId)) {
        const keepNode = nodesById.get(fromNodeId);
        const reacquired = movement.acquireReservation({
          employeeId,
          purpose: 'resting',
          nodeId: fromNodeId,
          segments: [],
          reservations: allReservations(externalReservations),
          nowMs: at,
          ttlMs: knob('reservationTtlMs'),
          safeRadius: keepNode ? keepNode.safeRadius : 0.02,
        });
        if (reacquired.ok) localReservations.push(reacquired.reservation);
      }
      // M4.1h dwell: the break area rests longest (12s default), any other
      // resting waypoint rests a little (6s), resting in place keeps the plain
      // minimum dwell so the office never parks everywhere at once.
      const dwellMs = target
        ? Math.round(restedInArea ? knob('restAreaDwellMs') : knob('restDwellMs'))
        : knob('minDwellMs');
      employee.current = {
        activity: 'resting',
        startedAt: at,
        nodeId: target ? target.nodeId : fromNodeId,
        dwellMs,
      };
      director.note({ employeeId, activity: 'resting', atMs: at });
      return Object.freeze({
        ok: true,
        employeeId,
        activity: 'resting',
        decidedAt: at,
        reason: movedForSpace ? `${reasonPrefix}:resting-moved-for-space` : `${reasonPrefix}:resting`,
        target: target ? Object.freeze({ nodeId: target.nodeId, route: Object.freeze(target.route) }) : null,
        wait: target ? null : Object.freeze({ waitMs: knob('waitMs'), reason: 'rest-target-unavailable' }),
        resting: Object.freeze({ restArea: restedInArea, dwellMs }),
        marker: null,
        ...(wakeFact || {}),
      });
    }

    releaseEmployeeReservations(employeeId);
    // M4.1h: probabilistic left target. When the walker DREW the left
    // preference and every left candidate is blocked, this decision WAITS (the
    // office keeps its promise "I am going to the break area") instead of
    // silently reversing into a right-side walk. The stand-down that spends the
    // patience budget lands on a LATER decision, never this one.
    const leftPlan = planRoamingTarget({ employeeId, fromNodeId, at, externalReservations, peers });
    let target = leftPlan.target || null;
    let leftBlocked = false;
    if (!target && leftPlan.blocked) {
      leftBlocked = true;
    } else if (!target) {
      // fair rotation: while the post-visit cooldown runs, the left pool is out
      // of reach for this walker (it must give the break area back). M4.1h r2:
      // the per-employee budget uses the same rule for a walker over its
      // ceiling (or for everyone while the office aggregate is high) — the
      // right-side pool is then the ONLY pool for this decision.
      const excludeLeft = employee.leftCooldownUntilMs > at || leftPlan.excludeLeft === true;
      const pool = excludeLeft
        ? graph.nodes
          .filter((node) => Array.isArray(node.tags) && node.tags.includes('roaming') && !node.id.startsWith('desk-'))
          .map((node) => node.id)
          .filter((nodeId) => !leftAreaNodeIds.includes(nodeId) && !leftHalfNodeIdSet.has(nodeId))
        : null;
      target = chooseTarget({
        employeeId,
        behavior: 'roaming',
        fromNodeId,
        at,
        externalReservations,
        peers,
        ...(pool ? { candidateIds: pool } : {}),
      });
      if (target) {
        noteRoamingDecision(employee, at, !!nodesById.get(target.nodeId)
          && leftAreaNodeIds.includes(target.nodeId));
      }
    }
    // M4.1h r2 fair lane: the claimant's turn ends as soon as this decision
    // stops pointing at the left half (it walked out, rested, chatted...), or
    // the moment it gives up on the retry (stand-down) so the lane passes to
    // the next under-served walker. A blocked-but-still-retrying claimant keeps
    // the lane (it is on its way).
    const leftTargetHeld = !!(target && leftHalfNodeIdSet.has(target.nodeId));
    const stillRetryingLeft = leftBlocked && leftPlan.blocked === 'left';
    if (leftClaim && leftClaim.employeeId === employeeId && !leftTargetHeld && !stillRetryingLeft) {
      releaseLeftClaim(employeeId);
    }
    employee.current = {
      activity: 'roaming',
      startedAt: at,
      nodeId: target ? target.nodeId : fromNodeId,
      // M4.1h r3: remember the corridor-priority grade of THIS walk, so the
      // module can mirror it for the route's whole duration (it must survive
      // the many decide() 'continue' calls between planning and arrival).
      leftPriority: (leftPlan.corridorPriority || 0) >= 1,
      dwellMs: leftBlocked
        ? knob('leftRetryMs')
        : (target && breakAreaNodeIdSet.has(target.nodeId) ? knob('leftRoamDwellMs') : null),
    };
    director.note({ employeeId, activity: 'roaming', atMs: at });
    if (target) {
      const t = leftDebug.targets[employeeId] || (leftDebug.targets[employeeId] = {});
      t[target.nodeId] = (t[target.nodeId] || 0) + 1;
    }
    return Object.freeze({
      ok: true,
      employeeId,
      activity: 'roaming',
      decidedAt: at,
      reason: leftBlocked
        ? `roaming-left-blocked:${leftPlan.blocked}`
        : roll === 'chatting' ? 'chat-unavailable-fallback' : `${reasonPrefix}:roaming`,
      target: target ? Object.freeze({ nodeId: target.nodeId, route: Object.freeze(target.route) }) : null,
      wait: target
        ? null
        : leftBlocked
          ? Object.freeze({ waitMs: Math.max(knob('waitMs'), 1500), reason: 'left-target-blocked' })
          : Object.freeze({ waitMs: knob('waitMs'), reason: 'roam-target-unavailable' }),
      left: Object.freeze({
        preferred: !!(leftPlan.left || leftBlocked),
        blocked: leftBlocked,
        blockKind: leftPlan.blocked || null,
        containedLeft: leftPlan.containedLeft === true,
      }),
      marker: null,
      ...(wakeFact || {}),
    });
  }

  // Trusted runtime facts or explicit commands interrupt any local activity
  // immediately. Sync changes are NOT interrupt reasons.
  function interruptForTask({ employeeId, reason = 'runtime-task', nowMs } = {}) {
    if (!INTERRUPT_REASONS.includes(reason)) {
      return fail('INTERRUPT_REASON_UNSUPPORTED', { reason: reason ?? null });
    }
    const employee = employees.get(employeeId);
    if (!employee) return fail('UNKNOWN_EMPLOYEE', { employeeId: employeeId ?? null });
    const at = atOrDefault(nowMs);
    const effects = [
      Object.freeze({ type: 'stop-movement', employeeId }),
      Object.freeze({ type: 'release-path-reservations', employeeId }),
    ];
    if (activeChatPair && (activeChatPair.a === employeeId || activeChatPair.b === employeeId)) {
      const other = activeChatPair.a === employeeId ? activeChatPair.b : activeChatPair.a;
      releaseEmployeeReservations(employeeId);
      releaseEmployeeReservations(other);
      releaseLeftClaim(employeeId);
      releaseLeftClaim(other);
      employees.get(other).current = null;
      effects.push(Object.freeze({ type: 'release-chat-lock', employees: Object.freeze([employeeId, other]) }));
      activeChatPair = null;
    } else {
      releaseEmployeeReservations(employeeId);
      releaseLeftClaim(employeeId);
    }
    // M4.1g: an interrupted nap ends the nap — the post-task idle clock plus
    // the refractory keep the resident from falling asleep on the spot again.
    if (employee.current && employee.current.activity === 'sleeping') {
      employee.napRefractoryUntil = at + effectiveConfig.sleepRefractoryMs;
    }
    employee.current = null;
    effects.push(Object.freeze({ type: 'begin-task-transition', employeeId, reason }));
    return Object.freeze({ ok: true, employeeId, reason, effects: Object.freeze(effects) });
  }

  // M4.1b: eviction memory — a preempted peer must not re-rest on the SAME
  // node it was asked to vacate (the yield used to achieve nothing because
  // decide() immediately re-picked rest-in-place there).
  const evictions = new Map(); // employeeId -> { nodeId, until }
  const EVICTION_MS = 8000;

  // M4.1a task priority: a local-activity holder (resting/chatting/roaming)
  // standing on a blocked task route yields — movement stops, reservations
  // release, and the next decide() re-picks a fresh local activity (the
  // scheduler walks it away). Unlike interruptForTask there is no task
  // transition: this employee has no work to do.
  function preemptLocal({ employeeId, reason = 'task-priority', nowMs, nodeId = null } = {}) {
    const employee = employees.get(employeeId);
    if (!employee) return fail('UNKNOWN_EMPLOYEE', { employeeId: employeeId ?? null });
    const at = atOrDefault(nowMs);
    if (typeof nodeId === 'string') evictions.set(employeeId, { nodeId, until: at + EVICTION_MS });
    const effects = [
      Object.freeze({ type: 'stop-movement', employeeId }),
      Object.freeze({ type: 'release-path-reservations', employeeId }),
    ];
    if (activeChatPair && (activeChatPair.a === employeeId || activeChatPair.b === employeeId)) {
      const other = activeChatPair.a === employeeId ? activeChatPair.b : activeChatPair.a;
      releaseEmployeeReservations(employeeId);
      releaseEmployeeReservations(other);
      releaseLeftClaim(employeeId);
      releaseLeftClaim(other);
      // M4.1h r2: a broken chat must carry the same per-pair cooldown endChat
      // does. Without it the two members re-pair IMMEDIATELY (they are standing
      // next to each other) and walk straight back into the same mutual block —
      // measured on seed m41d-chat-e: the same two employees re-formed a chat
      // they could never seat for the whole 30 minutes, so no bubble ever
      // appeared. The cooldown lets them disperse into different partners.
      employees.get(employeeId).cooldownUntil = at + knob('chatBreakCooldownMs');
      employees.get(other).cooldownUntil = at + knob('chatBreakCooldownMs');
      employees.get(other).current = null;
      effects.push(Object.freeze({ type: 'release-chat-lock', employees: Object.freeze([employeeId, other]) }));
      activeChatPair = null;
    } else {
      releaseEmployeeReservations(employeeId);
      releaseLeftClaim(employeeId);
    }
    // M4.1g: a preempted nap does not resume in place — the refractory makes
    // the next decision walk the resident away instead of re-sleeping.
    if (employee.current && employee.current.activity === 'sleeping') {
      employee.napRefractoryUntil = at + effectiveConfig.sleepRefractoryMs;
    }
    employee.current = null;
    effects.push(Object.freeze({ type: 'preempted-local', employeeId, reason }));
    return Object.freeze({ ok: true, employeeId, reason, at, effects: Object.freeze(effects) });
  }

  // M4.1h "允许中途换点": the module calls this at an INTERMEDIATE waypoint of a
  // live non-task roaming route. A seeded draw (scaled by the employee's
  // curiosity) decides whether the rest of that route is abandoned so the next
  // decision picks a fresh target. Only nodes are decision points — re-planning
  // mid-leg would cut a corner across the furniture (the module's straight-line
  // step has no path smoothing).
  function maybeAbandonRoute({ employeeId, atMs, hopsRemaining = 0 } = {}) {
    const employee = employees.get(employeeId);
    if (!employee) return Object.freeze({ ok: false, code: 'UNKNOWN_EMPLOYEE' });
    const at = atOrDefault(atMs);
    // M4.1h r3: a LIVE left mission is a promise the office already made — never
    // drop its route at an intermediate waypoint. Measured (r3 harness): the
    // mid-route retarget abandoned long left routes at the corridor gateway
    // (x>0.5), so an under-served walker re-targeted the wing over and over
    // without ever crossing into it (771 left targets, 0.000 left time in 30
    // min). Liveliness stays on for ordinary right-side walks.
    if (employee.current && employee.current.leftPriority === true) {
      return Object.freeze({ ok: true, abandon: false, at });
    }
    const chance = knob('midRouteRerouteChance') * personalityScale(employeeId, 'curiosity');
    if (!(chance > 0) || hopsRemaining <= 1) return Object.freeze({ ok: true, abandon: false, at });
    if (rngFor(employeeId)() >= chance) return Object.freeze({ ok: true, abandon: false, at });
    // The current activity ends here so the next decision is a real re-roll.
    employee.current = null;
    return Object.freeze({ ok: true, abandon: true, at });
  }

  // Live settings (office-module.updateSettings). Only the M4.1h knobs plus the
  // pre-existing pacing values are accepted; the structure (graph pool, seeds)
  // is fixed at creation. Unknown/ill-typed keys are ignored, never guessed.
  const KNOWN_LIVE_KEYS = Object.freeze([
    'leftRoamBias', 'leftRetryAttempts', 'leftRetryMs', 'restAreaAttraction',
    'restAreaDwellMs', 'restDwellMs', 'leftRoamDwellMs', 'midRouteRerouteChance', 'detourChance',
    'personality', 'waitMs', 'minDwellMs',
    'leftFairnessWindowMs', 'leftFairnessMaxShare', 'leftFairnessMinDecisions', 'leftCrowdLimit',
    'leftAfterVisitCooldownMs',
    'leftQuotaEnabled', 'leftQuotaWindowMs', 'leftQuotaFloor', 'leftQuotaCeiling',
    'leftQuotaMinRoamMs', 'leftQuotaCatchUpChance', 'leftQuotaAggregateFloor', 'leftQuotaClaimTtlMs',
    'leftCorridorPriority',
    'leftCorridorPriorityAll',
    'chatBreakCooldownMs',
  ]);
  function configure(partial) {
    const next = partial || {};
    for (const key of KNOWN_LIVE_KEYS) {
      const value = next[key];
      if (value === undefined) continue;
      if (key === 'personality' || key === 'leftQuotaEnabled' || key === 'leftCorridorPriority' || key === 'leftCorridorPriorityAll') {
        if (typeof value === 'boolean') live[key] = value;
        continue;
      }
      if (typeof value === 'number' && Number.isFinite(value)) live[key] = value;
    }
    if (Number.isFinite(next.leftRoamBias)) {
      director.configure({ leftRoamBias: next.leftRoamBias });
    }
    return Object.freeze({ ...live });
  }

  // M4.1h r2 observability: the per-employee left-time budget, read-only. Used
  // by the fairness regression test and the headless harness; carries no
  // per-employee identity beyond the id already in the office roster.
  function quotaSnapshot() {
    const officeShare = officeLeftQuotaShare();
    const perEmployee = {};
    for (const [employeeId, employee] of employees) {
      perEmployee[employeeId] = Object.freeze({
        roamMs: Math.round(employee.quotaRoamMs),
        leftMs: Math.round(employee.quotaLeftMs),
        share: leftQuotaShare(employee),
      });
    }
    return Object.freeze({ officeShare, perEmployee: Object.freeze(perEmployee) });
  }

  // M4.1h r3: is this employee currently WALKING toward the left half (a live
  // left mission)? Read-only, used by the module to describe the mission.
  function isLeftMission(employeeId) {
    const employee = employees.get(employeeId);
    if (!employee || !employee.current || employee.current.activity !== 'roaming') return false;
    const nodeId = employee.current.nodeId;
    return typeof nodeId === 'string' && leftHalfNodeIdSet.has(nodeId);
  }

  // M4.1h r3: does this employee's LIVE walk carry corridor passage priority?
  // The module reads it in hasWalkPriority so the mission's route releases a
  // conflicting roam leg instead of waiting at the gateway.
  function hasLeftCorridorPriority(employeeId) {
    const employee = employees.get(employeeId);
    if (!employee || !employee.current || employee.current.activity !== 'roaming') return false;
    return employee.current.leftPriority === true;
  }

  return Object.freeze({
    decide: Object.freeze(decide),
    preemptLocal: Object.freeze(preemptLocal),
    rollActivity: Object.freeze(rollActivity),
    chooseChatPartner: Object.freeze(chooseChatPartner),
    beginChat: Object.freeze(beginChat),
    endChat: Object.freeze(endChat),
    activeChatPair: Object.freeze(activeChatPairInfo),
    evaluateSleep: Object.freeze(evaluateSleep),
    markTaskStarted: Object.freeze(markTaskStarted),
    markTaskReleased: Object.freeze(markTaskReleased),
    interruptForTask: Object.freeze(interruptForTask),
    maybeAbandonRoute: Object.freeze(maybeAbandonRoute),
    configure: Object.freeze(configure),
    quotaSnapshot: Object.freeze(quotaSnapshot),
    isLeftMission: Object.freeze(isLeftMission),
    hasLeftCorridorPriority: Object.freeze(hasLeftCorridorPriority),
    leftDebug: Object.freeze(() => ({ skip: { ...leftDebug.skip }, emp: Object.fromEntries(Object.entries(leftDebug.emp).map(([k, v]) => [k, { ...v }])), targets: Object.fromEntries(Object.entries(leftDebug.targets).map(([k, v]) => [k, { ...v }])) })),
    reservations: Object.freeze(reservations),
    leftAreaNodeIds: Object.freeze([...leftAreaNodeIds]),
    restAreaNodeIds: Object.freeze([...restAreaNodeIdSet].sort()),
    restingNodeIds: Object.freeze([...restingNodeIds]),
    config: effectiveConfig,
  });
}

module.exports = {
  createBehaviorScheduler,
  DEFAULT_PROBABILITIES,
  DEFAULT_SLEEP_AFTER_MS,
  DEFAULT_MAX_SLEEPERS,
  DEFAULT_SLEEP_DURATION_RANGE_MS,
  DEFAULT_SLEEP_REFRACTORY_MS,
  DEFAULT_CONFIG,
  LOCAL_ACTIVITIES,
  INTERRUPT_REASONS,
};
