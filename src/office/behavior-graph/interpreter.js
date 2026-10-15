'use strict';

// src/office/behavior-graph/interpreter.js — the pure behaviour-graph interpreter
// (brief §8). The studio's preview runner executes it; the product can import the
// SAME module, which is the whole point of putting it under src/office.
//
// Purity contract: no DOM, no Electron, no filesystem, no network, no Date.now().
// Time comes from `tick(dtMs)`; randomness from a SEEDED generator (the same xmur3 +
// mulberry32 pair the behaviour scheduler uses, so a graph and the scheduler can be
// compared under one seed); effects are DATA the caller applies (the interpreter
// never walks anybody).
//
// Determinism: for a given (graph, seed, initial variables, event script, dt
// sequence) the trace, the effects and the final variables are identical. That is
// what makes "同一张图在工作台与 s1 运行时结果一致" checkable.

const { validateGraph } = require('./schema.js');

// == behavior-scheduler.js xmur3/mulberry32 (same algorithms, same seed handling)
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let index = 0; index < str.length; index += 1) {
    h = Math.imul(h ^ str.charCodeAt(index), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(a) {
  let state = a >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_TICK_CAP = 10000;

function createInterpreter({
  graph,
  seed = 'office-seed',
  clock = null,            // () => ms; injected so tests can run without wall time
  employees = ['employee-1'],
  initialVariables = {},   // { employeeId: {name: value}, scene: {name: value} }
  subgraphs = null,
  maxTicks = DEFAULT_TICK_CAP,
  onEffect = null,
  onTrace = null,
}) {
  const validation = validateGraph(graph, { subgraphs });
  if (!validation.ok) {
    return {
      ok: false,
      code: 'GRAPH_INVALID',
      violations: validation.violations,
      tick: () => ({ ok: false, code: 'GRAPH_INVALID' }),
      state: () => ({ ok: false, code: 'GRAPH_INVALID', violations: validation.violations }),
    };
  }

  const compiled = validation.graph;
  // PER-INSTANCE copies: nodes carry runtime state (loop counters, next-fire times,
  // once-flags), so sharing the caller's objects would leak state between runs and
  // break determinism.
  const nodesById = new Map(compiled.nodes.map((node) => [node.id, JSON.parse(JSON.stringify(node))]));
  const outgoing = new Map([...nodesById.keys()].map((id) => [id, []]));
  for (const edge of compiled.edges) {
    const port = edge.port || 'out';
    outgoing.get(edge.from).push({ to: edge.to, port });
  }
  const variableMeta = new Map((compiled.variables || []).map((variable) => [variable.name, variable]));

  // ---- state -----------------------------------------------------------------
  let nowMs = typeof clock === 'function' ? clock() : 0;
  const random = mulberry32(xmur3(String(seed))());
  const scopes = { scene: { ...(initialVariables.scene || {}) } };
  const traces = [];
  const effects = [];
  const threads = new Map();      // employeeId → token[]
  const breakpoints = new Set();
  const waits = [];               // { employeeId, tokenId, untilMs, nodeId }
  const watches = new Set();
  let tickCount = 0;
  let stoppedAt = null;

  for (const employeeId of employees) {
    scopes[employeeId] = { ...(initialVariables[employeeId] || {}) };
    threads.set(employeeId, []);
    // seed declared variables with their initial values
    for (const [name, meta] of variableMeta) {
      const scope = meta.scope === 'scene' ? scopes.scene : scopes[employeeId];
      if (!(name in scope)) scope[name] = meta.value === undefined ? null : meta.value;
    }
  }

  function record(kind, employeeId, detail) {
    const entry = { atMs: nowMs, kind, employeeId, ...detail };
    traces.push(entry);
    if (onTrace) onTrace(entry);
    return entry;
  }

  function emit(effect) {
    effects.push({ atMs: nowMs, ...effect });
    if (onEffect) onEffect(effects[effects.length - 1]);
    return effects[effects.length - 1];
  }

  function resolveValue(employeeId, reference) {
    if (typeof reference !== 'string') return reference;
    const scope = variableMeta.get(reference);
    if (scope && scope.scope === 'scene') return scopes.scene[reference];
    if (employeeId && scopes[employeeId] && reference in scopes[employeeId]) return scopes[employeeId][reference];
    return scopes.scene[reference];
  }

  function evaluate(test, employeeId) {
    const left = resolveValue(employeeId, test.left);
    const right = test.op === 'exists' ? undefined : resolveValue(employeeId, test.right);
    switch (test.op) {
      case '==': return left === right;
      case '!=': return left !== right;
      case '<': return Number(left) < Number(right);
      case '<=': return Number(left) <= Number(right);
      case '>': return Number(left) > Number(right);
      case '>=': return Number(left) >= Number(right);
      case 'exists': return left !== undefined && left !== null;
      case 'in': return Array.isArray(right) ? right.includes(left) : false;
      default: return false;
    }
  }

  function startToken(employeeId, nodeId) {
    if (stoppedAt) return null;   // already parked: the run is not advancing
    const token = { id: `${employeeId}:${traces.length}`, nodeId, waiting: null };
    if (breakpoints.has(nodeId)) {
      // The token is CREATED and parked (not dropped): `resume()` must continue the
      // very execution the breakpoint caught, otherwise debugging would change the
      // outcome — which is the one thing a debugger must never do.
      token.atBreakpoint = true;
      threads.get(employeeId).push(token);
      stoppedAt = { employeeId, nodeId, reason: 'breakpoint' };
      record('breakpoint', employeeId, { nodeId });
      return token;
    }
    threads.get(employeeId).push(token);
    return token;
  }

  // Execute one step of a token: returns 'advanced' | 'waiting' | 'done'.
  function stepToken(employeeId, token) {
    const node = nodesById.get(token.nodeId);
    if (!node) { removeToken(employeeId, token); return 'done'; }
    const nextPorts = (port) => outgoing.get(node.id).filter((edge) => edge.port === port).map((edge) => edge.to);
    const advance = (ports) => {
      removeToken(employeeId, token);
      for (const port of ports) for (const next of nextPorts(port)) startToken(employeeId, next);
      return 'advanced';
    };

    switch (node.type) {
      case 'trigger':
        record('trigger', employeeId, { nodeId: node.id, event: node.event || null });
        if (node.once) node.__fired = true;
        return advance(['out']);
      case 'condition': {
        const result = evaluate(node.test, employeeId);
        record('condition', employeeId, { nodeId: node.id, test: node.test, result });
        return advance([result ? 'true' : 'false']);
      }
      case 'wait': {
        if (node.until) {
          token.waiting = { kind: 'event', event: node.until.event, since: nowMs, timeoutMs: node.timeoutMs || null, nodeId: node.id };
          record('wait', employeeId, { nodeId: node.id, until: node.until });
          return 'waiting';
        }
        token.waiting = { kind: 'time', untilMs: nowMs + (node.ms || 0), nodeId: node.id };
        record('wait', employeeId, { nodeId: node.id, ms: node.ms || 0 });
        return 'waiting';
      }
      case 'parallel': {
        const branches = outgoing.get(node.id).filter((edge) => edge.port === 'out').map((edge) => edge.to);
        record('parallel', employeeId, { nodeId: node.id, branches: branches.length });
        removeToken(employeeId, token);
        for (const branch of branches) startToken(employeeId, branch);
        return 'advanced';
      }
      case 'join':
        record('join', employeeId, { nodeId: node.id });
        return advance(['out']);
      case 'loop': {
        // the iteration count belongs to the NODE per employee: the flow re-enters the
        // node for every pass, so a token-scoped counter would reset each time and the
        // bound would never be reached (found by the loop test).
        node.__iterations = node.__iterations || {};
        node.__iterations[employeeId] = (node.__iterations[employeeId] || 0) + 1;
        const iteration = node.__iterations[employeeId];
        if (node.max && iteration > node.max) {
          record('loop-exit', employeeId, { nodeId: node.id, iterations: iteration - 1 });
          node.__iterations[employeeId] = 0;   // a fresh pass next time round
          return advance(['exit']);
        }
        record('loop', employeeId, { nodeId: node.id, iteration, every: node.every || null });
        if (node.every) {
          token.waiting = { kind: 'time', untilMs: nowMs + node.every, nodeId: node.id };
          return 'waiting';
        }
        return advance(['out']);
      }
      case 'variable': {
        if (node.write) {
          const meta = variableMeta.get(node.write.name);
          const scope = meta && meta.scope === 'scene' ? scopes.scene : scopes[employeeId];
          scope[node.write.name] = node.write.value;
          record('variable.write', employeeId, { nodeId: node.id, name: node.write.name, value: node.write.value });
        } else {
          record('variable.read', employeeId, { nodeId: node.id, name: node.read, value: resolveValue(employeeId, node.read) });
        }
        return advance(['out']);
      }
      case 'action': {
        emit({ employeeId, nodeId: node.id, type: `action.${node.do}`, target: node.target || null, resource: node.resource || null, facing: node.facing || null, params: node.params || null });
        record('action', employeeId, { nodeId: node.id, do: node.do, target: node.target || null, resource: node.resource || null });
        return advance(['out']);
      }
      case 'dialogue': {
        emit({ employeeId, nodeId: node.id, type: 'action.bubble.show', topic: node.topic, peer: node.peer || null });
        record('dialogue', employeeId, { nodeId: node.id, topic: node.topic });
        return advance(['out']);
      }
      case 'emotion': {
        emit({ employeeId, nodeId: node.id, type: 'action.emotion.set', state: node.state });
        record('emotion', employeeId, { nodeId: node.id, state: node.state });
        return advance(['out']);
      }
      case 'feel': {
        emit({ employeeId, nodeId: node.id, type: 'action.feel', feel: { squash: node.squash || null, mirror: node.mirror === true, crossfadeMs: node.crossfadeMs || null, stepSync: node.stepSync || null } });
        record('feel', employeeId, { nodeId: node.id });
        return advance(['out']);
      }
      case 'subgraph': {
        const sub = subgraphs && subgraphs[node.graphId];
        if (!sub) {
          record('subgraph.missing', employeeId, { nodeId: node.id, graphId: node.graphId });
          return 'done';
        }
        // a subgraph runs as a nested interpreter with the SAME clock reading and a
        // derived seed, so nesting stays deterministic
        const nested = createInterpreter({ graph: sub, seed: `${seed}/${node.graphId}`, clock: () => nowMs, employees: [employeeId], initialVariables: { [employeeId]: scopes[employeeId], scene: scopes.scene }, subgraphs });
        nested.start();
        const outcome = nested.runUntilIdle();
        for (const effect of outcome.effects) emit({ ...effect, viaSubgraph: node.graphId });
        record('subgraph', employeeId, { nodeId: node.id, graphId: node.graphId, steps: outcome.steps });
        return advance(['out']);
      }
      default:
        return advance(['out']);
    }
  }

  function removeToken(employeeId, token) {
    const list = threads.get(employeeId) || [];
    const index = list.indexOf(token);
    if (index >= 0) list.splice(index, 1);
  }

  // Advance time and run every runnable token once per employee. A token that waits
  // stays parked; a trigger fires when its event arrives or its period elapses.
  function tick(dtMs = 0) {
    if (stoppedAt) return { ok: true, stopped: stoppedAt, steps: 0 };
    tickCount += 1;
    if (tickCount > maxTicks) return { ok: false, code: 'TICK_CAP', steps: 0 };
    nowMs += dtMs;
    let steps = 0;
    // periodic triggers (a `trigger` node with `every`) fire on their own schedule;
    // event triggers fire from inject(). Both create tokens the same way.
    for (const node of nodesById.values()) {
      if (node.type !== 'trigger' || typeof node.every !== 'number' || node.every <= 0) continue;
      if (node.__nextAt === undefined) node.__nextAt = nowMs + node.every;
      if (nowMs < node.__nextAt) continue;
      node.__nextAt = nowMs + node.every;
      if (node.once && node.__fired) continue;
      node.__fired = true;
      for (const employeeId of employees) startToken(employeeId, node.id);
      steps += 1;
    }
    for (const employeeId of employees) {
      const list = threads.get(employeeId) || [];
      for (const token of [...list]) {
        if (token.atBreakpoint) continue;   // parked by a breakpoint until resume()
        if (token.waiting) {
          // an EVENT wait with a timeout must not park forever: it resumes (and the
          // trace says why) once the budget is spent
          if (token.waiting.kind === 'event' && token.waiting.timeoutMs !== null && nowMs - token.waiting.since >= token.waiting.timeoutMs) {
            const resumedNode = token.waiting.nodeId;
            token.waiting = null;
            record('resume', employeeId, { nodeId: resumedNode, reason: 'timeout' });
            removeToken(employeeId, token);
            for (const edge of outgoing.get(resumedNode) || []) if ((edge.port || 'out') === 'out') startToken(employeeId, edge.to);
            steps += 1;
            continue;
          }
          if (token.waiting.kind === 'time' && nowMs >= token.waiting.untilMs) {
            const resumedNode = token.waiting.nodeId;
            token.waiting = null;
            record('resume', employeeId, { nodeId: resumedNode });
            const node = nodesById.get(resumedNode);
            // A resumed node leaves through its OWN port: `out` for a loop body, `out`
            // for anything else. Walking every outgoing edge here made a bounded loop
            // take its exit immediately (found by the loop test).
            removeToken(employeeId, token);
            for (const edge of outgoing.get(node.id) || []) if ((edge.port || 'out') === 'out') startToken(employeeId, edge.to);
            steps += 1;
          }
          continue;
        }
        const result = stepToken(employeeId, token);
        if (result !== 'waiting') steps += 1;
        if (stoppedAt) break;
      }
      if (stoppedAt) break;
    }
    return { ok: true, stopped: stoppedAt, steps, atMs: nowMs };
  }

  // Start the graph's entry points: every event-trigger fires once, and periodic
  // triggers begin their schedule. A subgraph invocation and a manual "run this
  // graph" both mean this — waiting for an event nobody sends is not a run.
  function start() {
    let started = 0;
    for (const node of nodesById.values()) {
      if (node.type !== 'trigger') continue;
      if (node.event) {
        if (node.once && node.__fired) continue;
        node.__fired = true;
        for (const employeeId of employees) { startToken(employeeId, node.id); started += 1; }
      } else if (typeof node.every === 'number') {
        node.__nextAt = nowMs + node.every;
      }
    }
    return { ok: true, started, atMs: nowMs };
  }

  function inject(event) {
    const name = typeof event === 'string' ? event : event.name;
    record('event', null, { name, payload: (event && event.payload) || null });
    let fired = 0;
    for (const employeeId of employees) {
      // parked event waits
      for (const token of [...(threads.get(employeeId) || [])]) {
        if (token.waiting && token.waiting.kind === 'event' && token.waiting.event === name) {
          token.waiting = null;
          removeToken(employeeId, token);
          for (const next of outgoing.get(nodesById.get(token.nodeId).id) || []) startToken(employeeId, next.to);
          record('resume', employeeId, { nodeId: token.nodeId, event: name });
          fired += 1;
        }
      }
      // triggers listening for this event
      for (const node of nodesById.values()) {
        if (node.type !== 'trigger' || node.event !== name) continue;
        if (node.once && node.__fired) continue;
        node.__fired = true;
        startToken(employeeId, node.id);
        fired += 1;
      }
    }
    if (stoppedAt && stoppedAt.reason !== 'breakpoint') stoppedAt = null;
    return { ok: true, fired, atMs: nowMs };
  }

  function runUntilIdle({ dtMs = 100, maxIterations = 1000 } = {}) {
    const started = nowMs;
    let iterations = 0;
    let steps = 0;
    for (;;) {
      const outcome = tick(dtMs);
      steps += outcome.steps || 0;
      iterations += 1;
      const parked = [...threads.values()].some((list) => list.length > 0);
      if (stoppedAt || !parked || iterations >= maxIterations) break;
    }
    return { ok: !stoppedAt, stopped: stoppedAt, steps, iterations, elapsedMs: nowMs - started, effects: [...effects], trace: [...traces] };
  }

  // Deterministic picks for weighted choices INSIDE graph actions (same generator as
  // the scheduler, so a graph choosing "what to do next" can be compared with it).
  function pick(entries) {
    const total = entries.reduce((sum, entry) => sum + (entry.weight || 0), 0);
    if (total <= 0) return null;
    let roll = random() * total;
    for (const entry of entries) {
      roll -= entry.weight || 0;
      if (roll <= 0) return entry;
    }
    return entries[entries.length - 1];
  }

  return {
    ok: true,
    start,
    tick,
    inject,
    pick,
    runUntilIdle,
    setBreakpoint: (nodeId, on = true) => { if (on) breakpoints.add(nodeId); else breakpoints.delete(nodeId); return { breakpoints: [...breakpoints] }; },
    clearBreakpoints: () => { breakpoints.clear(); stoppedAt = null; return { breakpoints: [] }; },
    resume: () => {
      stoppedAt = null;
      for (const list of threads.values()) for (const token of list) if (token.atBreakpoint) token.atBreakpoint = false;
      return { ok: true };
    },
    watch: (name, on = true) => { if (on) watches.add(name); else watches.delete(name); return { watches: [...watches] }; },
    variables: () => JSON.parse(JSON.stringify(scopes)),
    state: () => ({
      ok: true,
      atMs: nowMs,
      ticks: tickCount,
      stopped: stoppedAt,
      threads: [...threads.entries()].map(([employeeId, list]) => ({ employeeId, parked: list.map((token) => token.nodeId) })),
      variables: JSON.parse(JSON.stringify(scopes)),
      watch: [...watches].map((name) => ({ name, value: resolveValue(employees[0], name) })),
      effects: effects.length,
      traces: traces.length,
      randomState: random(),
    }),
    trace: () => [...traces],
    effects: () => [...effects],
    // a compact, comparable summary of the run (the diff report consumes this)
    summary: () => ({
      atMs: nowMs,
      effects: effects.map((effect) => `${effect.employeeId}:${effect.type}${effect.target ? `:${effect.target}` : ''}${effect.resource ? `:${effect.resource}` : ''}`),
      finalActivities: Object.fromEntries(employees.map((employeeId) => [employeeId, (traces.filter((entry) => entry.kind === 'action' && entry.employeeId === employeeId).pop() || {}).do || null])),
    }),
  };
}

module.exports = { DEFAULT_TICK_CAP, createInterpreter, mulberry32, xmur3 };
