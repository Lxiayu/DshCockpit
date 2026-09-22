'use strict';

// src/office/playground-page.js — Task 4 / SPEC-06 Animation Playground.
//
// ISOLATED single-character playground. Not the Office page: no Harness, no
// IPC business events, no office-state persistence, no employee registry.
// This module is the deterministic headless core shared by the page and the
// test fixture runner; the DOM/Pixi wiring lives in createPlaygroundView.
//
// The module is UMD: plain Node (tests) uses require(); the playground page
// consumes the window.__officeModules registry built by playground.html from
// dependency-free <script> tags (no bundler, no fetch for JS).
//
// Layers (decoupled, per character-animation-architecture):
//   FakeClock          — the ONLY time source (no Date.now/wall clock)
//   Reducer            — four-layer office state (Task 3 state-reducer)
//   Transition         — explicit phase orchestration (Task 3)
//   Movement           — normalized waypoints/routing (Task 3)
//   Animation          — independent frame clock + fallback (Task 3)
//   asset-pack         — Task 2 normalized pack resolution
//
// The animation clock and the movement clock are separate accumulators: a
// movement tick never advances frames and an animation tick never moves the
// character. Everything is JSON-replayable: the same seed + event list
// produces the same states, positions, frames and diagnostics every time.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./runtime/asset-pack.js'),
      require('./runtime/animation-controller.js'),
      require('./runtime/movement-controller.js'),
      require('./runtime/transition-controller.js'),
      require('./runtime/state-reducer.js')
    );
  } else if (root && root.__officeModules) {
    root.OfficePlayground = factory(
      root.__officeModules['asset-pack'],
      root.__officeModules['animation-controller'],
      root.__officeModules['movement-controller'],
      root.__officeModules['transition-controller'],
      root.__officeModules['state-reducer']
    );
  }
})(typeof window !== 'undefined' ? window : globalThis, function (
  assetPack,
  animationController,
  movementController,
  transitionController,
  stateReducer
) {


const SPEED_RATIO = 0.12;
const TICK_MS = 16;

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

function createFakeClock({ initialMs = 0 } = {}) {
  let base = initialMs;
  let advance = 0;
  let running = true;
  return {
    nowMs() {
      return base + advance;
    },
    advanceMs(ms) {
      if (running) advance += Math.max(0, ms);
      return this.nowMs();
    },
    pause() {
      running = false;
    },
    resume() {
      running = true;
    },
    isRunning() {
      return running;
    },
    stepMs(ms) {
      // Explicit debug stepper: advances even while paused.
      advance += Math.max(0, ms);
      return this.nowMs();
    },
    reset() {
      base = initialMs;
      advance = 0;
      running = true;
      return this.nowMs();
    },
  };
}

// ---------------------------------------------------------------------------
// Harness (single-character playground logic)
// ---------------------------------------------------------------------------

function createPlaygroundHarness(options) {
  const {
    pack,
    graph,
    scene: initialScene,
    seed = 'playground',
    startNodeId = null,
    events = [],
  } = options || {};

  if (!pack || typeof pack.resolve !== 'function') throw new Error('playground requires a resolved asset pack');
  if (!graph || !Array.isArray(graph.nodes)) throw new Error('playground requires a waypoint graph');

  const clock = createFakeClock();
  let scene = { width: initialScene.width, height: initialScene.height };
  // Debug controls (playground-level only; Task 3 modules stay untouched):
  // - speed: the movement controller instance is rebuilt with the new ratio
  //   (reservations are pure data passed explicitly on every call, so nothing
  //   is lost across rebuilds).
  // - direction: overrides the FACING used by animation selection only —
  //   never the logical position, routing or movement distance.
  // - loop: a pack view that overrides the resolved animation's loop flag.
  let speedRatio = SPEED_RATIO;
  let directionOverride = null;
  let loopOverride = null;
  let movementCtl = movementController.createMovementController({
    graph,
    config: { sceneMinDimensionPerSecond: speedRatio },
    clock,
  });
  const transition = transitionController.createTransitionController();

  let reducerState = stateReducer.createOfficeState();
  let directTargetEnabled = false;
  let reducedMotion = false;
  let frameDurationOverrideMs = null;
  let userState = null; // debug state selector; null = derive from state layers

  // Mutable runtime snapshot (per tick)
  const startNode = startNodeId
    ? graph.nodes.find((n) => n.id === startNodeId)
    : graph.nodes.find((n) => (n.tags || []).includes('roaming')) || graph.nodes[0];
  let position = { ...startNode.position };
  let target = null; // { point, nodeId, route }
  let currentTransition = null;
  let currentRoute = null;
  let currentRouteId = null;
  let routeIndex = 0;
  let arrived = false;
  let movingNow = false;
  let facing = 'down'; // last movement direction; persists while stationary
  let runningFactApplied = false;
  let animationElapsedMs = 0;
  const eventLog = [];
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));

  const ownStartReservation = movementCtl.acquireReservation({
    employeeId: 'playground',
    purpose: `node:${startNode.id}`,
    nodeId: startNode.id,
    reservations: [],
    nowMs: clock.nowMs(),
    ttlMs: 3_600_000,
    safeRadius: startNode.safeRadius || 0.02,
  });
  let pathReservationOwn = null;

  function activeReservations() {
    const list = [];
    if (ownStartReservation.ok) list.push(ownStartReservation.reservation);
    if (pathReservationOwn) list.push(pathReservationOwn);
    return list;
  }

  // ---- animation request mapping (playground-level; resources only) ------

  function deriveAnimationState() {
    if (currentTransition && currentTransition.kind === 'task-end') {
      if (currentTransition.phase === 'result') {
        return currentTransition.outcome === 'failed' ? 'failed' : 'completed';
      }
      return 'idle'; // stand / leave
    }
    const r = reducerState;
    if (r.runtime === 'completed') return 'completed';
    if (r.runtime === 'failed') return 'failed';
    if (r.activity === 'working') return 'working';
    if (r.activity === 'thinking') return 'thinking';
    if (r.activity === 'waiting') return 'waiting';
    if (r.activity === 'sleeping') return 'sleeping';
    if (r.activity === 'celebrating') return 'celebrating';
    return 'idle';
  }

  function animationState() {
    const direction = movementDirection();
    const moving = movingNow && !arrived;
    const derived = userState || deriveAnimationState();
    // Direction override (debug): affects the FACING only. While moving the
    // walk resource faces the override; while stationary and idle-like the
    // directional side pose faces it. Other states (working, thinking, …)
    // are direction-less and stay untouched. Position/routing never change.
    const overriddenIdle = !moving && directionOverride && derived === 'idle';
    const state = moving ? 'walk' : overriddenIdle ? 'side' : derived;
    const requestedDirection = moving || overriddenIdle ? direction : null;
    return animationController.resolveAnimation({
      state,
      direction: requestedDirection,
      elapsedMs: animationElapsedMs,
      pack: loopOverridePack(),
      userFrameDurationOverrideMs: frameDurationOverrideMs,
    });
  }

  // Pack view with the debug loop override: Task 3 animation-controller and
  // asset-pack stay untouched; only the resolved loop flag is substituted.
  function loopOverridePack() {
    if (loopOverride === null) return pack;
    return {
      resolve: (request) => {
        const selection = pack.resolve(request);
        if (selection.code === 'RESOLVED' && selection.loop !== loopOverride) {
          return { ...selection, loop: loopOverride };
        }
        return selection;
      },
      animation: (id) => pack.animation(id),
      frameGeometry: (id, index) => pack.frameGeometry(id, index),
      defaultFrameDurationMs: pack.defaultFrameDurationMs,
    };
  }

  function movementDirection() {
    // Debug direction override wins for FACING (animation + stationary);
    // auto mode keeps the dominant-axis direction and turn persistence.
    if (directionOverride) return directionOverride;
    if (movingNow && target) return movementDirectionBetween(position, target.point);
    return facing;
  }

  function movementDirectionBetween(from, to) {
    const dx = (to.x - from.x) * scene.width;
    const dy = (to.y - from.y) * scene.height;
    if (dx === 0 && dy === 0) return 'down';
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
    return dy > 0 ? 'down' : 'up';
  }

  function applyMovementDim(next) {
    if (reducerState.movement !== next) {
      reducerState = stateReducer.reduceOfficeState(reducerState, { type: 'movement/status', movement: next }).state;
    }
  }

  // ---- reservations -------------------------------------------------------

  function reservePath(route) {
    if (!route || route.length < 2) return null;
    const segments = [];
    for (let i = 0; i < route.length - 1; i += 1) {
      const a = nodesById.get(route[i]);
      const b = nodesById.get(route[i + 1]);
      if (!a || !b) return null;
      segments.push({ from: { ...a.position }, to: { ...b.position } });
    }
    const result = movementCtl.acquireReservation({
      employeeId: 'playground',
      purpose: 'path',
      segments,
      reservations: activeReservations(),
      nowMs: clock.nowMs(),
      ttlMs: 3_600_000,
      safeRadius: 0.04,
    });
    return result.ok ? result.reservation : null;
  }

  function releasePathReservation() {
    if (pathReservationOwn) {
      movementCtl.releaseReservation({ reservations: [], id: pathReservationOwn.id });
      pathReservationOwn = null;
    }
  }

  // ---- target management --------------------------------------------------

  function applyTarget(point, nodeId, route) {
    // Stale path state never survives a new target: the old path reservation
    // is released and the route replaced before the mover advances.
    releasePathReservation();
    currentRoute = Array.isArray(route) ? route.slice() : null;
    currentRouteId = Array.isArray(currentRoute) ? currentRoute.join('>') : null;
    routeIndex = 0;
    pathReservationOwn = reservePath(currentRoute);
    target = { point: { ...point }, nodeId: nodeId || null, route: currentRoute };
    arrived = false;
    movingNow = false;
    return { point: { ...point }, nodeId: target.nodeId, route: currentRoute };
  }

  function setScene(next) {
    // Resize keeps the logical position/target and only reprojects.
    scene = { width: next.width, height: next.height };
  }

  function clickToWaypoint(px, py, behavior = 'roaming', extraReservations = []) {
    const ranked = graph.nodes
      .filter((n) => (n.tags || []).includes(behavior))
      .map((node) => ({
        node,
        distance: Math.hypot(
          (node.position.x - px / scene.width) * scene.width,
          (node.position.y - py / scene.height) * scene.height
        ),
      }))
      .sort((a, b) => a.distance - b.distance || String(a.node.id).localeCompare(String(b.node.id)));
    for (const candidate of ranked) {
      const route = movementCtl.findRoute({
        fromNodeId: startNodeOf().id,
        toNodeId: candidate.node.id,
        behavior: null,
        reservations: extraReservations || [],
        nowMs: clock.nowMs(),
        employeeId: 'playground',
      });
      if (Array.isArray(route)) {
        return applyTarget({ ...candidate.node.position }, candidate.node.id, route);
      }
    }
    return null;
  }

  function startNodeOf() {
    let best = null;
    let bestDistance = Infinity;
    for (const node of graph.nodes) {
      const distance = Math.hypot(position.x - node.position.x, position.y - node.position.y);
      if (distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best || startNode;
  }

  function clickToTarget(px, py) {
    if (!directTargetEnabled) return null;
    return applyTarget({ x: px / scene.width, y: py / scene.height }, null, null);
  }

  // ---- event application --------------------------------------------------

  function applyEvent(event) {
    eventLog.push({ atMs: clock.nowMs(), type: event.type, payload: { ...event } });

    if (event.type === 'dispatch') {
      const node = graph.nodes.find((n) => n.id === event.targetNodeId);
      reducerState = stateReducer.reduceOfficeState(reducerState, { type: 'control/dispatch' }).state;
      const started = transition.beginTaskStart({
        fromActivity: reducerState.activity,
        task: { taskId: 'fixture-task' },
        target: node ? { nodeId: node.id } : null,
        nowMs: clock.nowMs(),
      });
      currentTransition = started.transition;
      runningFactApplied = false;
      if (node) {
        const route = movementCtl.findRoute({
          fromNodeId: startNodeOf().id,
          toNodeId: node.id,
          behavior: null,
          reservations: [],
          nowMs: clock.nowMs(),
          employeeId: 'playground',
        });
        if (Array.isArray(route)) {
          reducerState = stateReducer.reduceOfficeState(reducerState, { type: 'binding/bound', sessionId: 'playground-session' }).state;
          applyTarget({ ...node.position }, node.id, route);
          if (reducedMotion) {
            position = { ...node.position };
            arriveAtTarget(clock.nowMs());
          }
          return target;
        }
      }
      // Unreachable dispatch: no teleport, transition aborts with a reason.
      currentTransition = transition
        .advance({ transition: currentTransition, event: { type: 'interrupt', reason: 'target-unreachable' }, nowMs: clock.nowMs() })
        .transition;
      currentTransition = null;
      return null;
    }

    if (event.type === 'task-terminal') {
      const ended = transition.advance({
        transition: currentTransition,
        event: { type: 'task-terminal', outcome: event.outcome, result: event.result || null },
        nowMs: clock.nowMs(),
      });
      currentTransition = ended.transition;
      reducerState = stateReducer
        .reduceOfficeState(reducerState, { type: 'runtime/fact', fact: event.outcome, reason: event.outcome })
        .state;
      releasePathReservation();
      return currentTransition;
    }

    if (event.type === 'phase-complete') {
      if (!currentTransition) return null;
      const advanced = transition.advance({
        transition: currentTransition,
        event: { type: 'phase-complete' },
        nowMs: clock.nowMs(),
      });
      currentTransition = advanced.transition;
      if (!currentTransition) {
        reducerState = stateReducer.reduceOfficeState(reducerState, { type: 'transition/complete' }).state;
      }
      return currentTransition;
    }

    reducerState = stateReducer.reduceOfficeState(reducerState, event).state;
    return reducerState;
  }

  // ---- arrival ------------------------------------------------------------

  function arriveAtTarget(now) {
    arrived = true;
    movingNow = false;
    applyMovementDim('stationary');
    releasePathReservation();
    if (currentTransition && currentTransition.kind === 'task-start') {
      let next = transition.advance({ transition: currentTransition, event: { type: 'arrived' }, nowMs: now }).transition;
      while (next && next.kind === 'task-start' && next.phase !== 'work') {
        next = transition.advance({ transition: next, event: { type: 'phase-complete' }, nowMs: now }).transition;
      }
      currentTransition = next;
      if (currentTransition && currentTransition.phase === 'work' && !runningFactApplied) {
        reducerState = stateReducer.reduceOfficeState(reducerState, { type: 'runtime/fact', fact: 'running' }).state;
        runningFactApplied = true;
      }
    }
  }

  // ---- tickers ------------------------------------------------------------

  function tickMovement(dtMs) {
    const now = clock.nowMs();
    if (!target) {
      movingNow = false;
      applyMovementDim('stationary');
      return position;
    }
    if (reducedMotion) {
      // Reduced motion: reach the target immediately, keep advancing the
      // logical state (transition phases and reducer events still run).
      position = { ...target.point };
      arriveAtTarget(now);
      return position;
    }

    let legTarget = target.point;
    let finalLeg = true;
    if (currentRoute && currentRoute.length > 1 && routeIndex + 1 < currentRoute.length) {
      const nextNode = nodesById.get(currentRoute[routeIndex + 1]);
      if (nextNode) {
        legTarget = { ...nextNode.position };
        finalLeg = routeIndex + 2 >= currentRoute.length;
      }
    }

    const stepResult = movementCtl.step({
      position,
      target: legTarget,
      reservations: activeReservations(),
      dtMs,
      scene,
      employeeId: 'playground',
      nowMs: now,
      route: currentRoute,
    });
    position = { ...stepResult.position };
    movingNow = !!stepResult.moved && !stepResult.arrived;
    if (movingNow) facing = movementDirectionBetween(position, legTarget);
    applyMovementDim(movingNow ? 'moving' : 'stationary');

    if (stepResult.arrived) {
      if (!finalLeg) {
        routeIndex += 1; // intermediate waypoint reached; continue next tick
        arrived = false;
        movingNow = true;
      } else {
        arriveAtTarget(now);
      }
    }
    return position;
  }

  function tickAnimation(dtMs) {
    animationElapsedMs += Math.max(0, dtMs);
    clock.advanceMs(Math.max(0, dtMs));
    return animationState();
  }

  function tick(dtMs = TICK_MS) {
    // Both tickers read the same fake clock but keep independent schedules:
    // movement consumes dtMs as distance, animation only accumulates elapsed
    // time. Neither can affect the other.
    clock.advanceMs(Math.max(0, dtMs));
    tickMovement(dtMs);
    animationElapsedMs += Math.max(0, dtMs);
    return animationState();
  }

  function replay() {
    clock.reset();
    for (const event of events) {
      while (clock.nowMs() < event.atMs) tick(TICK_MS);
      applyEvent(event);
    }
    return diagnostics();
  }

  function diagnostics() {
    const animation = animationState();
    const layout = spriteLayout();
    return {
      schemaVersion: 1,
      seed,
      fakeTimeMs: clock.nowMs(),
      scene: { ...scene },
      position: { ...position },
      target: target ? { point: { ...target.point }, nodeId: target.nodeId, route: target.route } : null,
      direction: movementDirection(),
      arrived,
      routeId: currentRouteId,
      transition: currentTransition
        ? {
            kind: currentTransition.kind,
            phase: currentTransition.phase,
            outcome: currentTransition.outcome || null,
            reason: currentTransition.reason || null,
          }
        : null,
      animation: {
        resource: animation.resource,
        frameIndex: animation.frameIndex,
        frameElapsedMs: animation.frameElapsedMs,
        fallbackReason: animation.fallbackReason,
        emphasis: animation.emphasis || null,
      },
      reducer: {
        presence: reducerState.presence,
        sync: reducerState.sync,
        runtime: reducerState.runtime,
        activity: reducerState.activity,
        movement: reducerState.movement,
        control: reducerState.control,
        binding: reducerState.binding,
        queue: reducerState.queue,
      },
      geometry: {
        visibleHeight: layout.visibleHeight,
        spriteScale: layout.scale,
        anchor: { ...layout.anchor },
        visibleBounds: { ...layout.visibleBounds },
      },
      speedRatio,
      directionOverride,
      loopOverride,
      log: eventLog.map((entry) => ({ atMs: entry.atMs, type: entry.type })),
    };
  }

  // ---- geometry helpers ---------------------------------------------------

  function spriteLayout() {
    const visibleHeight = assetPack.computeVisibleHeight(scene.height);
    return {
      visibleHeight,
      scale: visibleHeight / pack.geometry.visibleBounds.height,
      anchor: { ...pack.geometry.anchor },
      visibleBounds: { ...pack.geometry.visibleBounds },
      outputCanvas: { ...pack.geometry.outputCanvas },
    };
  }

  return {
    clock,
    tick,
    tickMovement,
    tickAnimation,
    replay,
    applyEvent,
    clickToWaypoint,
    clickToTarget,
    setDirectTargetEnabled(value) {
      directTargetEnabled = !!value;
    },
    setReducedMotion(value) {
      reducedMotion = !!value;
    },
    setFrameDurationMs(value) {
      frameDurationOverrideMs = value;
    },
    setState(state) {
      userState = state;
    },
    setSpeed(ratio) {
      // Rebuild the movement controller with the new ratio; reservations are
      // pure data re-passed on every call, so no movement state is lost.
      if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return;
      speedRatio = ratio;
      movementCtl = movementController.createMovementController({
        graph,
        config: { sceneMinDimensionPerSecond: speedRatio },
        clock,
      });
    },
    setDirection(direction) {
      const valid = direction === null || direction === undefined || ['up', 'down', 'left', 'right'].includes(direction);
      directionOverride = valid && direction ? direction : null;
    },
    setLoop(value) {
      loopOverride = typeof value === 'boolean' ? value : null;
    },
    setScene,
    position: () => ({ ...position }),
    target: () => (target ? { point: { ...target.point }, nodeId: target.nodeId, route: target.route } : null),
    direction: movementDirection,
    arrived: () => arrived,
    isMoving: () => movingNow && !arrived,
    transition: () =>
      currentTransition
        ? { ...currentTransition, cleanup: { ...currentTransition.cleanup }, interrupted: currentTransition.interrupted ? { ...currentTransition.interrupted } : null }
        : null,
    reducerState: () => reducerState,
    animation: () => animationState(),
    animationElapsedMs: () => animationElapsedMs,
    scene: () => ({ ...scene }),
    spriteLayout,
    spriteLayoutFor(resourceId, frameIndex) {
      const frame = pack.frameGeometry(resourceId, frameIndex);
      const visibleHeight = assetPack.computeVisibleHeight(scene.height);
      return {
        file: frame.file,
        // ONE scale for every state/direction/frame: pack-level visibleBounds
        // drive the sprite scale so the visible height stays shared.
        scale: visibleHeight / pack.geometry.visibleBounds.height,
        anchor: frame.outputAnchor,
        visibleBounds: frame.visibleBounds,
        outputCanvas: frame.outputCanvas,
      };
    },
    screenPositionOf(logical) {
      return { x: logical.x * scene.width, y: logical.y * scene.height };
    },
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Pixi view wiring (renderer-only; tests use a stub PIXI)
// ---------------------------------------------------------------------------

async function createPlaygroundView({ PIXI, harness, textures, packBaseUrl = 'pack', mount = null, overlayNodes = null }) {
  const app = new PIXI.Application();
  await app.init({
    width: harness.scene().width,
    height: harness.scene().height,
    background: 0x1c2430,
    backgroundAlpha: 1,
    antialias: true,
    preference: 'webgl',
    preserveDrawingBuffer: true,
  });
  if (mount && app.canvas) mount.appendChild(app.canvas);

  let artVisible = true;
  let overlayVisible = true;

  const routeLayer = new PIXI.Graphics();
  const boundsLayer = new PIXI.Graphics();
  const footprintLayer = new PIXI.Graphics();
  const anchorLayer = new PIXI.Graphics();
  app.stage.addChild(routeLayer, boundsLayer, footprintLayer, anchorLayer);

  const sprite = new PIXI.Sprite(textures ? textures.get('idle') : PIXI.Texture.from('idle'));
  sprite.anchor.set(0, 0); // anchor math is explicit: node position IS the foot
  app.stage.addChild(sprite);

  function drawOverlay() {
    routeLayer.clear();
    boundsLayer.clear();
    footprintLayer.clear();
    anchorLayer.clear();
    const scene = harness.scene();
    const pos = harness.position();
    const foot = { x: pos.x * scene.width, y: pos.y * scene.height };
    const layout = harness.spriteLayout();
    const target = harness.target();

    if (target) {
      routeLayer.moveTo(foot.x, foot.y);
      if (target.route && target.route.length && overlayNodes) {
        for (const nodeId of target.route) {
          const node = overlayNodes.get ? overlayNodes.get(nodeId) : overlayNodes[nodeId];
          if (node) routeLayer.lineTo(node.position.x * scene.width, node.position.y * scene.height);
        }
      } else {
        routeLayer.lineTo(target.point.x * scene.width, target.point.y * scene.height);
      }
      routeLayer.stroke({ width: 2, color: 0x4fc3f7, alpha: 0.9 });
    }

    const vb = layout.visibleBounds;
    const scale = layout.scale;
    const topLeft = {
      x: foot.x - (layout.anchor.x - vb.x) * scale,
      y: foot.y - (layout.anchor.y - vb.y) * scale,
    };
    boundsLayer
      .rect(topLeft.x, topLeft.y, vb.width * scale, vb.height * scale)
      .stroke({ width: 1, color: 0xffd54f, alpha: 0.9 });
    const footprintRadius = 0.05 * Math.min(scene.width, scene.height);
    footprintLayer.circle(foot.x, foot.y, footprintRadius).stroke({ width: 1, color: 0x81c784, alpha: 0.8 });
    anchorLayer.circle(foot.x, foot.y, 3).fill(0xff5252);
    anchorLayer.circle(foot.x, foot.y, 6).stroke({ width: 1, color: 0xff8a80, alpha: 0.9 });
  }

  function refresh() {
    const animation = harness.animation();
    const resourceId = animation.resource || 'idle';
    const frameIndex = animation.frameIndex || 0;
    const frameLayout = harness.spriteLayoutFor(resourceId, frameIndex);
    const texture = textures ? textures.get(frameLayout.file) : PIXI.Texture.from(frameLayout.file);
    if (texture) sprite.texture = texture;
    const layout = harness.spriteLayout();
    const scale = layout.scale;
    sprite.__scale = scale;
    const pos = harness.position();
    const anchor = frameLayout.anchor;
    sprite.scale.set(scale);
    // Node position = foot point; the frame's outputAnchor lands exactly on
    // it. No CSS/Pixi offset compensation anywhere.
    sprite.x = pos.x * harness.scene().width - anchor.x * scale;
    sprite.y = pos.y * harness.scene().height - anchor.y * scale;
    sprite.visible = artVisible;
    if (overlayVisible) drawOverlay();
  }

  return {
    app,
    sprite,
    layers: { routeLayer, boundsLayer, footprintLayer, anchorLayer },
    refresh,
    resize({ width, height }) {
      // Resize reprojects only: logical position/target stay untouched.
      app.renderer.resize(width, height);
      refresh();
    },
    setArtVisible(value) {
      artVisible = !!value;
      sprite.visible = artVisible;
    },
    setOverlayVisible(value) {
      overlayVisible = !!value;
      if (!overlayVisible) {
        routeLayer.clear();
        boundsLayer.clear();
        footprintLayer.clear();
        anchorLayer.clear();
      }
    },
    destroy() {
      try {
        sprite.destroy(true);
      } catch {
        /* already destroyed */
      }
      try {
        app.destroy(true, { children: true, texture: false });
      } catch {
        /* already destroyed */
      }
    },
  };
}

  return {
    createFakeClock,
    createPlaygroundHarness,
    createPlaygroundView,
    SPEED_RATIO,
    TICK_MS,
  };
});
