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
// - default decision probabilities: roaming 60% / resting 25% / chatting 15%
// - minimum dwell time and chat cooldowns are honored
// - target selection goes through the injected movement controller's
//   waypoint/reservation contract (findRoute + acquireReservation): never a
//   teleport; unavailable targets pick a same-tag candidate or a short wait
// - at most ONE chat pair exists; chat-a/chat-b seats are reserved ATOMICALLY
//   (either failure cancels both); the pair keeps fixed seats and facing
// - sleeping unlocks after the configured idle threshold (default 300000 ms),
//   defaults to the personal desk, and is blocked by unfinished bindings or
//   sync != healthy
// - trusted running/attention facts or explicit commands interrupt any local
//   activity immediately (releasing both chat reservations); sync=stale/
//   resyncing NEVER ends local behavior and never triggers sleeping
// - identical seed + identical call sequence => identical decisions

const profiles = require('./employee-profile.js');

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
const DEFAULT_CONFIG = Object.freeze({
  probabilities: DEFAULT_PROBABILITIES,
  minDwellMs: 4000,
  chatCooldownMs: 20000,
  sleepAfterMs: DEFAULT_SLEEP_AFTER_MS,
  waitMs: 800,
  reservationTtlMs: 60000,
  chatSeatTtlMs: 120000,
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

  const employees = new Map();
  for (const employeeId of ids) {
    const profile = profiles.getResidentProfile(employeeId) || (employeeId === profiles.COLLABORATOR_ID ? profiles.getCollaboratorProfile() : null);
    employees.set(employeeId, {
      employeeId,
      displayName: profile ? profile.displayName : employeeId,
      defaultSeat: profile ? profile.defaultSeat : null,
      cooldownUntil: 0,
      idleSince: now(),
      current: null,
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
    localReservations.push(seatA.reservation, seatB.reservation);
    activeChatPair = { a: employeeId, b: partnerId, startedAt: at, seatA: seats[0].id, seatB: seats[1].id };
    employees.get(employeeId).current = { activity: 'chatting', startedAt: at, nodeId: seats[0].id };
    employees.get(partnerId).current = { activity: 'chatting', startedAt: at, nodeId: seats[1].id };
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
    return Object.freeze({
      employeeId,
      eligible: blockers.length === 0,
      idleMs,
      thresholdMs: threshold,
      blockers: Object.freeze(blockers),
    });
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
  function occupiedFromPeers(peers) {
    const occupied = new Set();
    if (!Array.isArray(peers)) return occupied;
    for (const peer of peers) {
      if (!peer) continue;
      if (typeof peer.currentNodeId === 'string' && peer.currentNodeId) occupied.add(peer.currentNodeId);
      if (typeof peer.targetNodeId === 'string' && peer.targetNodeId) occupied.add(peer.targetNodeId);
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

  function chooseTarget({ employeeId, behavior, fromNodeId, at, externalReservations, preferredNodeId, peers = [] }) {
    let candidates;
    if (behavior === 'sleeping') {
      candidates = preferredNodeId && nodesById.has(preferredNodeId) ? [preferredNodeId] : [];
    } else {
      candidates = graph.nodes
        .filter((node) => Array.isArray(node.tags) && node.tags.includes(behavior) && node.id !== fromNodeId)
        // M4.1b: roaming never targets the roaming-tagged desk-*-leave nodes —
        // they made walkers wander to other people's workstations (reads as
        // "串工位"); every other roaming-tagged spot stays eligible.
        .filter((node) => (behavior === 'roaming' ? !node.id.startsWith('desk-') : true))
        .map((node) => node.id);
      candidates = shuffled(candidates, rngFor(employeeId));
      // Keep-away: spacious candidates first (same seeded order inside each
      // group), crowded ones kept as the liveness fallback.
      if (behavior !== 'sleeping') {
        const spacious = [];
        const crowded = [];
        for (const nodeId of candidates) {
          (isCrowded(nodesById.get(nodeId), peers) ? crowded : spacious).push(nodeId);
        }
        candidates = [...spacious, ...crowded];
      }
    }
    const all = allReservations(externalReservations);
    for (const nodeId of candidates) {
      const route = movement.findRoute({
        fromNodeId,
        toNodeId: nodeId,
        behavior,
        reservations: all,
        nowMs: at,
        employeeId,
        occupiedNodeIds: occupiedFromPeers(peers),
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
        ttlMs: effectiveConfig.reservationTtlMs,
        safeRadius: node ? node.safeRadius : 0.02,
      });
      if (!acquired.ok) continue;
      localReservations.push(acquired.reservation);
      return { nodeId, route: [...route], reservation: acquired.reservation };
    }
    return null;
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
    } = request || {};
    const employee = employees.get(employeeId);
    if (!employee) return fail('UNKNOWN_EMPLOYEE', { employeeId: employeeId ?? null });
    const at = atOrDefault(nowMs);
    const current = employee.current;

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

    // Minimum dwell: an ongoing local activity is not re-decided.
    if (current && current.activity && at - current.startedAt < effectiveConfig.minDwellMs) {
      return Object.freeze({
        ok: true,
        employeeId,
        activity: 'continue',
        decidedAt: at,
        current: Object.freeze({ activity: current.activity, startedAt: current.startedAt }),
      });
    }

    // Sleep gate: threshold + no unfinished binding + healthy sync only.
    const sleepCheck = evaluateSleep({ employeeId, nowMs: at, bindingActive, sync });
    if (sleepCheck.eligible) {
      releaseEmployeeReservations(employeeId);
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
        employee.current = { activity: 'sleeping', startedAt: at, nodeId: target ? target.nodeId : fromNodeId };
        return Object.freeze({
          ok: true,
          employeeId,
          activity: 'sleeping',
          decidedAt: at,
          reason: 'sleep-threshold',
          target: target ? Object.freeze({ nodeId: target.nodeId, route: Object.freeze(target.route) }) : null,
          wait: target ? null : Object.freeze({ waitMs: effectiveConfig.waitMs, reason: 'sleep-desk-unavailable' }),
          marker: Object.freeze({ kind: 'sleep-zzz', accessibleLabel: `${employee.displayName} 正在小憩` }),
        });
      }
      // fall through: desk unreachable and not standing at it — stay awake
    }

    // A forced sleeping request that is blocked falls back to staying awake.
    let roll = forceActivity && forceActivity !== 'sleeping' ? forceActivity : rollActivity(employeeId);
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
      let target = chooseTarget({ employeeId, behavior: 'resting', fromNodeId, at, externalReservations, peers });
      // M4.1e: the flat layout has no resting-tagged waypoint, so resting means
      // "stay where I am". A crowded spot (a peer within personal space) makes
      // that read as two characters standing on top of each other — walk to a
      // quiet roaming spot instead, and only rest in place when even that is
      // unavailable.
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
          ttlMs: effectiveConfig.reservationTtlMs,
          safeRadius: keepNode ? keepNode.safeRadius : 0.02,
        });
        if (reacquired.ok) localReservations.push(reacquired.reservation);
      }
      employee.current = { activity: 'resting', startedAt: at, nodeId: target ? target.nodeId : fromNodeId };
      return Object.freeze({
        ok: true,
        employeeId,
        activity: 'resting',
        decidedAt: at,
        reason: movedForSpace ? `${reasonPrefix}:resting-moved-for-space` : `${reasonPrefix}:resting`,
        target: target ? Object.freeze({ nodeId: target.nodeId, route: Object.freeze(target.route) }) : null,
        wait: target ? null : Object.freeze({ waitMs: effectiveConfig.waitMs, reason: 'rest-target-unavailable' }),
        marker: null,
      });
    }

    releaseEmployeeReservations(employeeId);
    const target = chooseTarget({ employeeId, behavior: 'roaming', fromNodeId, at, externalReservations, peers });
    employee.current = { activity: 'roaming', startedAt: at, nodeId: target ? target.nodeId : fromNodeId };
    return Object.freeze({
      ok: true,
      employeeId,
      activity: 'roaming',
      decidedAt: at,
      reason: roll === 'chatting' ? 'chat-unavailable-fallback' : `${reasonPrefix}:roaming`,
      target: target ? Object.freeze({ nodeId: target.nodeId, route: Object.freeze(target.route) }) : null,
      wait: target ? null : Object.freeze({ waitMs: effectiveConfig.waitMs, reason: 'roam-target-unavailable' }),
      marker: null,
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
      employees.get(other).current = null;
      effects.push(Object.freeze({ type: 'release-chat-lock', employees: Object.freeze([employeeId, other]) }));
      activeChatPair = null;
    } else {
      releaseEmployeeReservations(employeeId);
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
      employees.get(other).current = null;
      effects.push(Object.freeze({ type: 'release-chat-lock', employees: Object.freeze([employeeId, other]) }));
      activeChatPair = null;
    } else {
      releaseEmployeeReservations(employeeId);
    }
    employee.current = null;
    effects.push(Object.freeze({ type: 'preempted-local', employeeId, reason }));
    return Object.freeze({ ok: true, employeeId, reason, at, effects: Object.freeze(effects) });
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
    reservations: Object.freeze(reservations),
    config: effectiveConfig,
  });
}

module.exports = {
  createBehaviorScheduler,
  DEFAULT_PROBABILITIES,
  DEFAULT_SLEEP_AFTER_MS,
  DEFAULT_CONFIG,
  LOCAL_ACTIVITIES,
  INTERRUPT_REASONS,
};
