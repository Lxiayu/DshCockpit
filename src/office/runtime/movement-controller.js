'use strict';

// src/office/runtime/movement-controller.js — Task 3 / SPEC-03.
//
// Deterministic normalized-space movement and Waypoint Graph routing.
// No Electron/Pixi/DOM/fs/network/clock/random access: every call receives
// explicit position, target, graph, reservations, dt, scene and nowMs.
//
// Coordinate model (character-movement-system spec):
// - positions/targets are normalized [0,1] ratios
// - screen distance = hypot(dx * width, dy * height)
// - speed = sceneMinDimensionPerSecond * min(width, height) px/s
//   (default ratio 0.12)
// - resize preserves logical position/target and only reprojects
// - circular safeRadius/chat geometry scale with the MIN scene dimension
//
// Routing: deterministic BFS that preserves fixture edge order, filters by
// behavior tags, node capacity, safeRadius zones and active reservations
// (expired reservations are ignored). No route => { code: 'UNREACHABLE' }.
// Movement never teleports and never silently snaps to the target.
//
// Reservations: acquire (capacity + segment-conflict checked), renewal at
// half-life, release on arrival, plus cancellation/completion/interruption/
// timeout semantics. A reservation carries owner, purpose, acquiredAt,
// expiresAt and route segment information.

const DEFAULT_SPEED_RATIO = 0.12;
const ARRIVAL_TOLERANCE = 0.01;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPoint2(value) {
  return !!value && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function minSceneDimension(scene) {
  return Math.min(scene.width, scene.height);
}

function screenDistance(a, b, scene) {
  return Math.hypot((b.x - a.x) * scene.width, (b.y - a.y) * scene.height);
}

function normalizedSpeed(scene, config) {
  const ratio =
    config && config.sceneMinDimensionPerSecond !== undefined && config.sceneMinDimensionPerSecond !== null
      ? config.sceneMinDimensionPerSecond
      : DEFAULT_SPEED_RATIO;
  return (ratio * minSceneDimension(scene)) / 1000;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

// Direction from the dominant screen-space segment axis with a deterministic
// tie-break (x axis wins ties, then positive direction).
function directionFor(from, to, scene) {
  const dx = (to.x - from.x) * scene.width;
  const dy = (to.y - from.y) * scene.height;
  if (dx === 0 && dy === 0) return 'down';
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

function toPx(point, scene) {
  return { x: point.x * scene.width, y: point.y * scene.height };
}

function orientationPx(p, q, r) {
  const v = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function onSegmentPx(p, q, r) {
  return (
    q.x >= Math.min(p.x, r.x) &&
    q.x <= Math.max(p.x, r.x) &&
    q.y >= Math.min(p.y, r.y) &&
    q.y <= Math.max(p.y, r.y)
  );
}

function segmentsIntersectPx(a1, a2, b1, b2) {
  const o1 = orientationPx(a1, a2, b1);
  const o2 = orientationPx(a1, a2, b2);
  const o3 = orientationPx(b1, b2, a1);
  const o4 = orientationPx(b1, b2, a2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegmentPx(a1, b1, a2)) return true;
  if (o2 === 0 && onSegmentPx(a1, b2, a2)) return true;
  if (o3 === 0 && onSegmentPx(b1, a1, b2)) return true;
  if (o4 === 0 && onSegmentPx(b1, a2, b2)) return true;
  return false;
}

function pointSegmentDistancePx(point, a1, a2) {
  const abx = a2.x - a1.x;
  const aby = a2.y - a1.y;
  const length2 = abx * abx + aby * aby;
  let t = length2 === 0 ? 0 : ((point.x - a1.x) * abx + (point.y - a1.y) * aby) / length2;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(point.x - (a1.x + abx * t), point.y - (a1.y + aby * t));
}

function segmentDistancePx(a1, a2, b1, b2) {
  if (segmentsIntersectPx(a1, a2, b1, b2)) return 0;
  return Math.min(
    pointSegmentDistancePx(b1, a1, a2),
    pointSegmentDistancePx(b2, a1, a2),
    pointSegmentDistancePx(a1, b1, b2),
    pointSegmentDistancePx(a2, b1, b2)
  );
}

// Two segments conflict when they intersect or when the minimum distance
// between them in screen space is within the combined safety radius, which
// uses the circular MIN-scene-dimension metric.
function segmentsConflict(aFrom, aTo, bFrom, bTo, scene, radiusRatio) {
  const radiusPx = radiusRatio * minSceneDimension(scene);
  if (radiusPx <= 0) return false;
  const distance = segmentDistancePx(toPx(aFrom, scene), toPx(aTo, scene), toPx(bFrom, scene), toPx(bTo, scene));
  return distance <= radiusPx;
}

function reservationActive(reservation, nowMs) {
  return reservation.expiresAt === null || reservation.expiresAt === undefined || reservation.expiresAt > nowMs;
}

// Only an own reservation that actually covers the CURRENT movement segment
// (a path reservation containing both movement endpoints) may carry crossing
// priority. Unrelated older reservations — node or path — never do.
const SEGMENT_EPSILON = 1e-9;

function segmentContainsPoint(segment, point) {
  if (!isPoint2(segment.from) || !isPoint2(segment.to) || !isPoint2(point)) return false;
  const abx = segment.to.x - segment.from.x;
  const aby = segment.to.y - segment.from.y;
  const length2 = abx * abx + aby * aby;
  if (length2 === 0) return false;
  const cross = abx * (point.y - segment.from.y) - aby * (point.x - segment.from.x);
  if (Math.abs(cross) > SEGMENT_EPSILON) return false;
  const t = ((point.x - segment.from.x) * abx + (point.y - segment.from.y) * aby) / length2;
  return t >= -SEGMENT_EPSILON && t <= 1 + SEGMENT_EPSILON;
}

function reservationCoversMovement(reservation, from, to) {
  if (!Array.isArray(reservation.segments) || reservation.segments.length === 0) return false;
  return reservation.segments.some(
    (segment) => segmentContainsPoint(segment, from) && segmentContainsPoint(segment, to)
  );
}

function nodeCapacityUsed(graph, nodeId, reservations, nowMs, exceptOwner) {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return Infinity;
  let used = 0;
  for (const reservation of reservations) {
    if (!reservationActive(reservation, nowMs)) continue;
    if (exceptOwner !== undefined && reservation.owner === exceptOwner) continue;
    if (reservation.nodeId === nodeId) used += 1;
  }
  return used;
}

// Minimum distance from a point to a segment in normalized coordinates
// (unit-scene metric, consistent with normalized safeRadius values).
function pointSegmentDistanceNormalized(point, segment) {
  const abx = segment.to.x - segment.from.x;
  const aby = segment.to.y - segment.from.y;
  const length2 = abx * abx + aby * aby;
  let t = length2 === 0 ? 0 : ((point.x - segment.from.x) * abx + (point.y - segment.from.y) * aby) / length2;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(point.x - (segment.from.x + abx * t), point.y - (segment.from.y + aby * t));
}

// A path reservation blocks a node when ANY of its reserved segments comes
// within the node's combined safety radius — not just the first segment.
function pathReservationReachesNode(node, reservation) {
  const radius = Math.max(node.safeRadius || 0, reservation.safeRadius || 0);
  const segments = Array.isArray(reservation.segments) ? reservation.segments : [];
  for (const segment of segments) {
    if (!isPoint2(segment.from) || !isPoint2(segment.to)) continue;
    if (pointSegmentDistanceNormalized(node.position, segment) <= radius) return true;
  }
  return false;
}

// M4.1h r3: `priority` is the corridor-passage relaxation, graded 1..2.
// 1 = ignore a peer BODY standing on a path node (occupancy): a walker's own
//     destination blocks everyone behind it, so one parked body made the whole
//     left wing read "unreachable" and 70% of preferred-left decisions were
//     dropped. The runtime occupant gate still refuses to clip into the body.
// 2 = additionally ignore a peer's PATH reservation (the node it is walking
//     toward). Measured: level 2 for every left intent saturates the wing
//     (pooled 0.516) and halves the chat seeds' bubbles, so it is reserved for
//     the under-served walkers the corridor priority exists for.
// A parked peer's NODE reservation is never ignored: capacity is enforced.
function isNodeBlockedByReservation(graph, nodeId, reservations, nowMs, exceptOwner, priority = 0) {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return null;
  for (const reservation of reservations) {
    if (!reservationActive(reservation, nowMs)) continue;
    if (exceptOwner !== undefined && reservation.owner === exceptOwner) continue;
    if (reservation.nodeId === nodeId) {
      const used = nodeCapacityUsed(graph, nodeId, reservations, nowMs, exceptOwner);
      if (used >= (node.capacity || 1)) return reservation;
      continue;
    }
    // safeRadius zone: any active reservation whose position is within the
    // combined safety radius of this node blocks entering it.
    const radius = Math.max(node.safeRadius || 0, reservation.safeRadius || 0);
    if (reservation.nodeId) {
      const center = (graph.nodes.find((candidate) => candidate.id === reservation.nodeId) || {}).position;
      if (!center) continue;
      const distance = Math.hypot(center.x - node.position.x, center.y - node.position.y);
      if (distance <= radius) return reservation;
      continue;
    }
    if (pathReservationReachesNode(node, reservation)) {
      if (priority >= 2) continue;
      return reservation;
    }
  }
  return null;
}

// M4.1a: body awareness — a mover never advances into the social distance of
// another body, whatever the reservation bookkeeping says (unreserved
// parkers, expired reservations and arrival snaps all collapse into this one
// gate). occupants: [{ id, position, radius }] with radius in scene-ratio.
// M4.1b: pass-through social distance — matches the module's occupant gate
// (0.03 ≈ 25px) so every 'too close to a body' decision uses one number.
const OCCUPANT_SOCIAL_RADIUS = 0.03;

function createMovementController({ graph, config, clock } = {}) {
  const speedRatio =
    config && config.sceneMinDimensionPerSecond !== undefined && config.sceneMinDimensionPerSecond !== null
      ? config.sceneMinDimensionPerSecond
      : DEFAULT_SPEED_RATIO;
  const now = clock && typeof clock.nowMs === 'function' ? clock.nowMs : () => 0;

  function routeIdFor(route) {
    if (!Array.isArray(route) || route.length === 0) return null;
    return route.join('>');
  }

  // M4.1h r3: `priority` = "corridor passage priority", graded 0/1/2 (see
  // isNodeBlockedByReservation). A walker on a promised left-rest mission may
  // PLAN through same-capacity bodies / a moving peer's route instead of
  // standing at the gateway because one peer happens to occupy the first chain
  // node. Planning is all this skips: the runtime occupant gate still refuses
  // to step into a body (no clipping), and the caller's acquireReservation
  // still enforces node CAPACITY, so a genuinely full target is never planned.
  // Without it the left wing measured 70% of
  // preferred-left decisions "blocked" with no reachable candidate even though
  // the corridor would have cleared a moment later.
  // 2026-09-26 工位缺陷修复：`blockedSegments` = 同伴"正在走/正站在"的几何
  // 线段（当前腿或身体位置点）。规划期避开这些线段（社交半径 0.03，与
  // step 时的 occupant gate 同一个数），任务路线就不会规划进对向走廊——
  // 规划进去了就是 1D 对向死锁（双方身体互挡、无任何出口，实测冻结 240s+）。
  // 找不到绕路时返回 UNREACHABLE，由调用方的 retry 梯子等走廊腾空。
  function findRoute({ fromNodeId, toNodeId, behavior, reservations, nowMs, employeeId, occupiedNodeIds = null, priority = false, blockedSegments = null } = {}) {
    const at = nowMs !== undefined ? nowMs : now();
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const from = nodesById.get(fromNodeId);
    const to = nodesById.get(toNodeId);
    if (!from || !to) return Object.freeze({ code: 'UNREACHABLE' });
    if (fromNodeId === toNodeId) return Object.freeze([fromNodeId]);

    const blocked = Array.isArray(blockedSegments) && blockedSegments.length > 0
      ? blockedSegments.filter((segment) => segment && isPoint2(segment.from) && isPoint2(segment.to))
      : null;
    const edgeBlockedByBody = (nodeA, nodeB) => {
      if (!blocked) return false;
      for (const segment of blocked) {
        if (segmentsConflict(segment.from, segment.to, nodeA.position, nodeB.position, { width: 1, height: 1 }, OCCUPANT_SOCIAL_RADIUS)) return true;
      }
      return false;
    };

    const adjacency = new Map();
    for (const edge of graph.edges) {
      const allowed = !edge.behaviors || !behavior || edge.behaviors.includes(behavior);
      if (edge.bidirectional) {
        if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
        adjacency.get(edge.from).push({ to: edge.to, allowed });
        if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
        adjacency.get(edge.to).push({ to: edge.from, allowed });
      } else {
        if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
        adjacency.get(edge.from).push({ to: edge.to, allowed });
      }
    }

    // M4.1e follow-up: a node with a standing BODY is not a waypoint. A
    // capacity-2 node may legally hold a second reservation, so reservation
    // checks alone let a route plan straight through a parked body — the step
    // then refuses forever (three-body chains froze the corridor for ~58s).
    // The walker's own node is obviously exempt.
    const occupied = occupiedNodeIds instanceof Set ? occupiedNodeIds : new Set(Array.isArray(occupiedNodeIds) ? occupiedNodeIds : []);
    const visited = new Set([fromNodeId]);
    const parent = new Map();
    let queue = [fromNodeId];
    while (queue.length > 0) {
      const nextQueue = [];
      for (const currentId of queue) {
        const edges = adjacency.get(currentId) || [];
        const currentNode = nodesById.get(currentId);
        for (const edge of edges) {
          if (!edge.allowed || visited.has(edge.to)) continue;
          const node = nodesById.get(edge.to);
          if (!node) continue;
          if (priority < 1 && occupied.has(edge.to) && edge.to !== fromNodeId) continue;
          // 工位缺陷修复：这条边的几何线段若与同伴身体/当前腿冲突，规划期
          // 直接绕开（找不到绕路 ⇒ UNREACHABLE，retry 梯子等走廊腾空）。
          if (currentNode && !priority && edgeBlockedByBody(currentNode, node) && edge.to !== toNodeId) continue;
          // Reservation checks apply to EVERY entered node, including the
          // route target: a full-capacity or protected target must force an
          // alternate route or UNREACHABLE, never a planned intrusion.
          const blocked = isNodeBlockedByReservation(graph, edge.to, reservations || [], at, employeeId, priority);
          if (blocked) continue;
          visited.add(edge.to);
          parent.set(edge.to, currentId);
          if (edge.to === toNodeId) {
            const path = [toNodeId];
            let cursor = toNodeId;
            while (parent.has(cursor)) {
              cursor = parent.get(cursor);
              path.unshift(cursor);
            }
            return Object.freeze(path);
          }
          nextQueue.push(edge.to);
        }
      }
      queue = nextQueue;
    }
    return Object.freeze({ code: 'UNREACHABLE' });
  }

  // Advances one step toward `target` along `route` (when supplied). When the
  // position is already within the arrival tolerance the mover stays put and
  // the caller receives a release action for its reservation.
  function step(request) {
    const {
      position,
      target,
      targetNodeId = null,
      reservations = [],
      occupants = [],
      dtMs = 0,
      scene,
      employeeId,
      nowMs,
      route = null,
    } = request || {};
    const at = nowMs !== undefined ? nowMs : now();

    if (!isPoint2(position) || !isPoint2(target) || !scene || !(scene.width > 0) || !(scene.height > 0)) {
      return Object.freeze({
        code: 'MOVEMENT_INVALID_INPUT',
        position: Object.freeze({ x: position && isFiniteNumber(position.x) ? position.x : 0, y: position && isFiniteNumber(position.y) ? position.y : 0 }),
        direction: 'down',
        progress: 0,
        arrived: false,
        moved: false,
        routeId: null,
        reservationAction: 'none',
        blockedBy: null,
      });
    }

    const routeId = routeIdFor(route);
    const arrivedNow = screenDistance(position, target, scene) / minSceneDimension(scene) <= ARRIVAL_TOLERANCE;
    if (arrivedNow) {
      return Object.freeze({
        code: 'OK',
        position: Object.freeze({ ...target }),
        direction: directionFor(position, target, scene),
        progress: 1,
        arrived: true,
        moved: false,
        routeId,
        reservationAction: 'release',
        blockedBy: null,
      });
    }

    if (route && !Array.isArray(route)) {
      return Object.freeze({
        code: 'UNREACHABLE',
        position: Object.freeze({ ...position }),
        direction: directionFor(position, target, scene),
        progress: 0,
        arrived: false,
        moved: false,
        routeId: null,
        reservationAction: 'none',
        blockedBy: null,
      });
    }

    // Segment reservation conflict: active path reservations owned by other
    // employees whose capsule overlaps this segment's capsule make the later
    // mover wait (never reroute through teleport).
    const from = position;
    const to = target;
    for (const reservation of reservations) {
      if (!reservationActive(reservation, at)) continue;
      if (employeeId !== undefined && reservation.owner === employeeId) continue;
      if (!reservation.segments || reservation.segments.length === 0) continue;
      const radius = reservation.safeRadius || 0;
      for (const segment of reservation.segments) {
        if (segmentsConflict(segment.from, segment.to, from, to, scene, radius)) {
          // 2026-09-26 工位缺陷修复：yield 规则必须给出全序。旧条件是严格的
          // `acquiredAt < acquiredAt`——同一条 tick 里先后 plan 的两条任务路线
          // （同 logicalMs ⇒ acquiredAt 相同）互相冲突时双方都拿不出"更早的
          // 自己"，双双进入 wait： coder 的腿被 reviewer 的身体挡住、reviewer
          // 的腿被 collaborator 的腿预留挡住、collaborator 的腿被 coder 的
          // 身体挡住（实测 5 人同开工位时底部走廊三人环，位置冻结 540s+），
          // 而 handleBlocked 的让位/重规划出口都把 task-bound 员工排除在外，
          // 死锁无人可解。平手时用 owner id 的字典序做确定性破平：任何一对
          // 冲突的移动者中恰好一个获胜前进，等待图无环。
          const mine = reservations.find(
            (candidate) =>
              candidate.owner === employeeId &&
              reservationActive(candidate, at) &&
              reservationCoversMovement(candidate, from, to) &&
              (candidate.acquiredAt < reservation.acquiredAt
                || (candidate.acquiredAt === reservation.acquiredAt
                  && String(employeeId) < String(reservation.owner)))
          );
          if (!mine) {
            return Object.freeze({
              code: 'OK',
              position: Object.freeze({ ...position }),
              direction: directionFor(from, to, scene),
              progress: 0,
              arrived: false,
              moved: false,
              routeId,
              reservationAction: 'wait',
              blockedBy: Object.freeze({ owner: reservation.owner, reservationId: reservation.id || null }),
            });
          }
        }
      }
    }

    // Node reservations with safeRadius also block segments passing nearby.
    // The mover's own half-radius adds to the node's combined zone.
    const moverRadiusRatio = 0.02;
    for (const reservation of reservations) {
      if (!reservationActive(reservation, at)) continue;
      if (employeeId !== undefined && reservation.owner === employeeId) continue;
      if (!reservation.nodeId) continue;
      // 2026-09-26 工位缺陷修复：workstation 预留保护的是"座位锚点供其主人
      // 到达"，而工位 approach 节点紧贴过道（实测 desk-5-approach 距
      // roam-6>roam-5 走道仅 0.0009）。座位上没人时，这条预留却以社交半径
      // 硬挡一切过路腿——5 人同批开工时互相挡死（3 身体 + 1 预留的等待环，
      // 位置冻结 540s+）。现在无人占座的 workstation 预留只挡"以它为落点"
      // 的腿（isTarget 全半径不变：别人不能把腿收进别人的座位），不再挡
      // 纯路过；主人身体真的站上去之后由 occupant gate 继续保护。
      if (reservation.purpose === 'workstation' && targetNodeId !== reservation.nodeId) continue;
      const node = graph && graph.nodes ? graph.nodes.find((candidate) => candidate.id === reservation.nodeId) : null;
      if (!node) continue;
      // M4.1b: two different protections. ARRIVING at the reserved node keeps
      // the full parking radius; merely PASSING a parked peer only keeps the
      // social distance. Using the parking radius for pass-through deadlocked
      // every edge that runs within it — and compiled edges legitimately run
      // closer than 0.05 (their furniture clearance is 0.04).
      const isTarget = targetNodeId !== null && reservation.nodeId === targetNodeId;
      const radius = isTarget
        ? Math.max(node.safeRadius || 0, reservation.safeRadius || 0) + moverRadiusRatio
        : OCCUPANT_SOCIAL_RADIUS;
      const distancePx = pointSegmentDistancePx(toPx(node.position, scene), toPx(from, scene), toPx(to, scene));
      if (distancePx <= radius * minSceneDimension(scene)) {
        return Object.freeze({
          code: 'OK',
          position: Object.freeze({ ...position }),
          direction: directionFor(from, to, scene),
          progress: 0,
          arrived: false,
          moved: false,
          routeId,
          reservationAction: 'wait',
          blockedBy: Object.freeze({ owner: reservation.owner, reservationId: reservation.id || null }),
        });
      }
    }

    // M4.1a occupant gate: never step into another body's social circle.
    for (const occupant of occupants) {
      if (!occupant || !occupant.position) continue;
      if (employeeId !== undefined && occupant.id === employeeId) continue;
      const radius = (occupant.radius !== undefined && occupant.radius !== null ? occupant.radius : OCCUPANT_SOCIAL_RADIUS);
      if (radius <= 0) continue;
      // M4.1h: a body the mover is ALREADY overlapping (two residents legally
      // parked on one capacity-2 node) must not veto the step AWAY from it —
      // the movement segment starts inside that body's circle, so the social
      // gate held both of them there for as long as they stood together
      // (measured: a chat pair co-located on roam-2 could not separate, so the
      // pair never reached its seats and the conversation silently expired).
      // Only the departure is freed: every other occupant keeps the full gate,
      // and the step still cannot END inside anyone (the target is checked by
      // its own arrival radius).
      if (screenDistance(from, occupant.position, scene) <= ARRIVAL_TOLERANCE * minSceneDimension(scene)) continue;
      const distancePx = pointSegmentDistancePx(toPx(occupant.position, scene), toPx(from, scene), toPx(to, scene));
      if (distancePx <= radius * minSceneDimension(scene)) {
        return Object.freeze({
          code: 'OK',
          position: Object.freeze({ ...position }),
          direction: directionFor(from, to, scene),
          progress: 0,
          arrived: false,
          moved: false,
          routeId,
          reservationAction: 'wait',
          blockedBy: Object.freeze({ owner: occupant.id || null, reservationId: null }),
        });
      }
    }

    const speed = normalizedSpeed(scene, { sceneMinDimensionPerSecond: speedRatio });
    const dtSeconds = isFiniteNumber(dtMs) && dtMs > 0 ? dtMs : 0;
    const distancePx = screenDistance(from, to, scene);
    const travelPx = speed * dtSeconds;
    const ownReservations = employeeId === undefined ? [] : reservations.filter((candidate) => candidate.owner === employeeId);
    const renewalAction = ownReservations.some((reservation) => reservationActive(reservation, at) && isRenewalDue(reservation, at))
      ? 'renew'
      : 'none';
    if (travelPx >= distancePx) {
      return Object.freeze({
        code: 'OK',
        position: Object.freeze({ ...target }),
        direction: directionFor(from, to, scene),
        progress: 1,
        arrived: true,
        moved: dtSeconds > 0,
        routeId,
        reservationAction: 'release',
        blockedBy: null,
      });
    }

    const ratio = travelPx / distancePx;
    const next = {
      x: clamp01(from.x + (to.x - from.x) * ratio),
      y: clamp01(from.y + (to.y - from.y) * ratio),
    };
    return Object.freeze({
      code: 'OK',
      position: Object.freeze(next),
      direction: directionFor(from, to, scene),
      progress: ratio,
      arrived: false,
      moved: dtSeconds > 0,
      routeId,
      reservationAction: dtSeconds > 0 ? renewalAction : 'none',
      blockedBy: null,
    });
  }

  function acquireReservation({ employeeId, purpose, nodeId = null, segments = [], reservations = [], nowMs, ttlMs = 60000, safeRadius = 0.05 }) {
    const at = nowMs !== undefined ? nowMs : now();
    if (nodeId) {
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        return Object.freeze({ ok: false, code: 'RESERVATION_UNKNOWN_NODE' });
      }
      const used = nodeCapacityUsed(graph, nodeId, reservations, at, employeeId);
      if (used >= (node.capacity || 1)) {
        return Object.freeze({ ok: false, code: 'RESERVATION_CAPACITY' });
      }
      for (const reservation of reservations) {
        if (!reservationActive(reservation, at) || reservation.owner === employeeId) continue;
        const radius = Math.max(node.safeRadius || 0, reservation.safeRadius || 0);
        if (reservation.nodeId) {
          const center = (graph.nodes.find((candidate) => candidate.id === reservation.nodeId) || {}).position;
          if (!center) continue;
          if (Math.hypot(center.x - node.position.x, center.y - node.position.y) <= radius) {
            return Object.freeze({ ok: false, code: 'RESERVATION_CONFLICT' });
          }
          continue;
        }
        if (pathReservationReachesNode(node, reservation)) {
          return Object.freeze({ ok: false, code: 'RESERVATION_CONFLICT' });
        }
      }
    }
    for (const reservation of reservations) {
      if (!reservationActive(reservation, at) || reservation.owner === employeeId) continue;
      if (!reservation.segments || reservation.segments.length === 0 || segments.length === 0) continue;
      for (const segment of segments) {
        for (const other of reservation.segments) {
          if (
            segmentsConflict(
              other.from,
              other.to,
              segment.from,
              segment.to,
              { width: 1, height: 1 },
              Math.max(reservation.safeRadius || 0, safeRadius)
            )
          ) {
            return Object.freeze({ ok: false, code: 'RESERVATION_CONFLICT' });
          }
        }
      }
    }
    const reservation = Object.freeze({
      id: `res-${employeeId}-${purpose}-${at}`,
      owner: employeeId,
      purpose,
      nodeId,
      segments: Object.freeze(segments.map((segment) => Object.freeze({ ...segment }))),
      safeRadius,
      acquiredAt: at,
      expiresAt: at + ttlMs,
      ttlMs,
      lastRenewedAt: at,
      renewalCount: 0,
    });
    return Object.freeze({ ok: true, code: 'OK', reservation });
  }

  function renewReservation({ reservation, nowMs }) {
    const at = nowMs !== undefined ? nowMs : now();
    return Object.freeze({
      ...reservation,
      expiresAt: at + reservation.ttlMs,
      lastRenewedAt: at,
      renewalCount: (reservation.renewalCount || 0) + 1,
    });
  }

  function isRenewalDue(reservation, nowMs) {
    const at = nowMs !== undefined ? nowMs : now();
    const anchor = reservation.lastRenewedAt !== undefined && reservation.lastRenewedAt !== null
      ? reservation.lastRenewedAt
      : reservation.acquiredAt;
    const halfLife = anchor + reservation.ttlMs / 2;
    return at >= halfLife;
  }

  function releaseReservation({ reservations, id, owner }) {
    const kept = reservations.filter((reservation) => {
      if (id !== undefined && reservation.id === id) return false;
      if (owner !== undefined && reservation.owner === owner) return false;
      return true;
    });
    return Object.freeze({ reservations: Object.freeze(kept), released: reservations.length - kept.length });
  }

  return Object.freeze({
    step: Object.freeze(step),
    findRoute: Object.freeze(findRoute),
    acquireReservation: Object.freeze(acquireReservation),
    renewReservation: Object.freeze(renewReservation),
    isRenewalDue: Object.freeze(isRenewalDue),
    releaseReservation: Object.freeze(releaseReservation),
  });
}

// M4.1a: list the reservations whose capsule conflicts with the given
// segments (used by the module to grant task routes priority over roam legs).
function findConflictingReservations({ reservations = [], segments = [], scene, employeeId = undefined } = {}) {
  const conflicts = [];
  for (const reservation of reservations) {
    if (!reservation || !Array.isArray(reservation.segments) || reservation.segments.length === 0) continue;
    if (employeeId !== undefined && reservation.owner === employeeId) continue;
    const radius = reservation.safeRadius || 0;
    for (const a of segments) {
      for (const b of reservation.segments) {
        if (segmentsConflict(b.from, b.to, a.from, a.to, scene, radius)) {
          conflicts.push(reservation);
          break;
        }
      }
      if (conflicts[conflicts.length - 1] === reservation) break;
    }
  }
  return conflicts;
}

module.exports = {
  createMovementController,
  findConflictingReservations,
  DEFAULT_SPEED_RATIO,
  ARRIVAL_TOLERANCE,
};
