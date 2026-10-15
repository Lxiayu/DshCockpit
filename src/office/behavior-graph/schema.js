'use strict';

// src/office/behavior-graph/schema.js — the .vgraph contract (brief §8).
//
// A behaviour graph is DATA: `{ schemaVersion, id, meta, variables, nodes, edges }`.
// This module is the single validator for it — the studio writes graphs, the
// interpreter runs them, and BOTH use this file, so a graph that validates here
// cannot mean two different things.
//
// Purity: no DOM, no Electron, no filesystem, no network. The product may import it
// (it lives under src/office on purpose); nothing here imports the product.

const SCHEMA_VERSION = 1;

// Every node type declares its ports as (name → type). Types are FIXED — there is no
// "wildcard" port, so a mis-wired graph is a validation error, not a runtime surprise.
const FLOW = 'flow';
const VALUE = 'value';
const BOOL = 'bool';

const NODE_TYPES = Object.freeze({
  // ---- triggers (execution starts here) ----
  trigger: {
    kind: 'trigger',
    required: ['event|every'],
    fields: { event: 'string', every: 'number', once: 'boolean' },
    ports: { out: FLOW },
  },
  // ---- control ----
  condition: {
    kind: 'control',
    required: ['test'],
    fields: { test: 'object' },   // { left, op, right } — a closed set, never eval()
    ports: { in: FLOW, true: FLOW, false: FLOW },
  },
  wait: {
    kind: 'control',
    required: ['ms|until'],
    fields: { ms: 'number', until: 'object', timeoutMs: 'number' },
    ports: { in: FLOW, out: FLOW },
  },
  parallel: { kind: 'control', required: [], fields: {}, ports: { in: FLOW, out: FLOW } },
  join: { kind: 'control', required: [], fields: {}, ports: { in: FLOW, out: FLOW } },
  loop: {
    kind: 'control',
    required: [],
    fields: { every: 'number', max: 'number' },
    // each iteration advances `out`; once `max` is exceeded the flow leaves through
    // `exit` — without a separate exit port a bounded loop cannot terminate cleanly
    ports: { in: FLOW, out: FLOW, exit: FLOW },
  },
  subgraph: {
    kind: 'control',
    required: ['graphId'],
    fields: { graphId: 'string' },
    ports: { in: FLOW, out: FLOW },
  },
  variable: {
    kind: 'control',
    required: ['write|read'],
    fields: { write: 'object', read: 'string' },
    ports: { in: FLOW, out: FLOW },
  },
  // ---- actions (the interpreter emits EFFECTS; the runtime applies them) ----
  action: {
    kind: 'action',
    required: ['do'],
    fields: { do: 'string', target: 'string', resource: 'string', facing: 'string', params: 'object' },
    ports: { in: FLOW, out: FLOW },
  },
  dialogue: {
    kind: 'action',
    required: ['topic'],
    fields: { topic: 'string', peer: 'string' },
    ports: { in: FLOW, out: FLOW },
  },
  emotion: {
    kind: 'action',
    required: ['state'],
    fields: { state: 'string' },
    ports: { in: FLOW, out: FLOW },
  },
  // ---- the feel layer (pure parameters; the runtime maps them to transforms) ----
  feel: {
    kind: 'action',
    required: [],
    fields: { squash: 'object', mirror: 'boolean', crossfadeMs: 'number', stepSync: 'object' },
    ports: { in: FLOW, out: FLOW },
  },
});

// The closed action vocabulary: `do` may only be one of these (brief §8: 闭集动作).
const ACTIONS = Object.freeze([
  'walk.to', 'sit', 'stand', 'animation.set', 'video.play', 'bubble.show',
  'task.accept', 'task.release', 'transition.start', 'transition.cancel',
  // the office's local activity vocabulary (roaming/resting/chatting/sleeping — the
  // same set behavior-scheduler.js uses), expressed as a state change so a graph and
  // the scheduler can be compared on one vocabulary
  'activity.set',
]);

// The closed comparison operators for `condition.test` — no eval(), no expressions.
const OPERATORS = Object.freeze(['==', '!=', '<', '<=', '>', '>=', 'exists', 'in']);

const STOP_CODES = Object.freeze(['OK', 'GRAPH_INVALID', 'NO_TRIGGER', 'CYCLE', 'PORT_TYPE', 'VARIABLE_UNKNOWN', 'ACTION_UNKNOWN', 'OPERATOR_UNKNOWN', 'SUBGRAPH_MISSING']);

function fail(code, detail = {}) {
  return { ok: false, code, detail };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fieldTypeOk(value, type) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'object') return isPlainObject(value);
  return false;
}

function validateGraph(graph, { subgraphs = null } = {}) {
  const violations = [];
  const push = (check, detail) => violations.push({ check, detail });
  if (!isPlainObject(graph)) return { ok: false, violations: [{ check: 'graph.shape', detail: 'a graph must be a JSON object' }] };
  if (graph.schemaVersion !== SCHEMA_VERSION) push('graph.schemaVersion', `expected ${SCHEMA_VERSION}, got ${JSON.stringify(graph.schemaVersion)}`);
  if (typeof graph.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(graph.id)) push('graph.id', 'id must be kebab-case [a-z0-9-]');
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) push('graph.nodes', 'a graph needs at least one node');
  if (!Array.isArray(graph.edges)) push('graph.edges', 'edges must be an array');
  if (graph.variables !== undefined && !Array.isArray(graph.variables)) push('graph.variables', 'variables must be an array');

  const variables = new Map();
  for (const [index, variable] of (graph.variables || []).entries()) {
    if (!isPlainObject(variable) || typeof variable.name !== 'string') { push(`graph.variables[${index}]`, 'a variable needs a name'); continue; }
    const scope = variable.scope === undefined ? 'employee' : variable.scope;
    if (!['employee', 'scene'].includes(scope)) push(`graph.variables[${index}].scope`, 'scope must be employee|scene');
    variables.set(variable.name, { scope, type: variable.type || 'any' });
  }

  const nodes = new Map();
  for (const [index, node] of (graph.nodes || []).entries()) {
    if (!isPlainObject(node) || typeof node.id !== 'string' || !node.id) { push(`graph.nodes[${index}]`, 'a node needs an id'); continue; }
    if (nodes.has(node.id)) { push(`graph.nodes[${index}]`, `duplicate node id ${node.id}`); continue; }
    const spec = NODE_TYPES[node.type];
    if (!spec) { push(`graph.nodes[${index}].type`, `unknown node type ${JSON.stringify(node.type)} — the vocabulary is closed`); continue; }
    // required fields: 'a|b' means either a or b
    for (const requirement of spec.required) {
      const anyOf = requirement.split('|');
      if (!anyOf.some((name) => node[name] !== undefined)) push(`graph.nodes[${index}]`, `${node.type} needs ${anyOf.join(' or ')}`);
    }
    for (const [field, type] of Object.entries(spec.fields)) {
      if (node[field] === undefined) continue;
      if (!fieldTypeOk(node[field], type)) push(`graph.nodes[${index}].${field}`, `${field} must be a ${type}`);
    }
    if (node.type === 'action') {
      if (!ACTIONS.includes(node.do)) push(`graph.nodes[${index}].do`, `unknown action ${JSON.stringify(node.do)} — the closed set is ${ACTIONS.join(', ')}`);
    }
    if (node.type === 'condition') {
      const test = node.test;
      if (!isPlainObject(test) || !('left' in test) || !('op' in test)) push(`graph.nodes[${index}].test`, 'test must be { left, op, right? }');
      else {
        if (!OPERATORS.includes(test.op)) push(`graph.nodes[${index}].test.op`, `unknown operator ${JSON.stringify(test.op)} — the closed set is ${OPERATORS.join(', ')}`);
        if (test.op !== 'exists' && test.right === undefined) push(`graph.nodes[${index}].test.right`, `operator ${test.op} needs a right-hand side`);
      }
    }
    if (node.type === 'subgraph') {
      if (subgraphs && !subgraphs[node.graphId]) push(`graph.nodes[${index}].graphId`, `subgraph ${JSON.stringify(node.graphId)} is not provided`);
    }
    if (node.type === 'variable') {
      const name = node.write ? node.write.name : node.read;
      if (name !== undefined && !variables.has(name)) push(`graph.nodes[${index}]`, `variable ${JSON.stringify(name)} is not declared in graph.variables`);
      if (node.write && !isPlainObject(node.write)) push(`graph.nodes[${index}].write`, 'write must be { name, value }');
    }
    nodes.set(node.id, { node, spec });
  }

  const edges = [];
  for (const [index, edge] of (graph.edges || []).entries()) {
    if (!isPlainObject(edge) || typeof edge.from !== 'string' || typeof edge.to !== 'string') { push(`graph.edges[${index}]`, 'an edge needs from and to'); continue; }
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from) { push(`graph.edges[${index}].from`, `unknown node ${edge.from}`); continue; }
    if (!to) { push(`graph.edges[${index}].to`, `unknown node ${edge.to}`); continue; }
    // PORT TYPES: the source port must exist and the target must accept it
    const port = edge.port || 'out';
    const portType = from.spec.ports[port];
    if (!portType) { push(`graph.edges[${index}].port`, `${edge.from} has no port ${JSON.stringify(port)} (ports: ${Object.keys(from.spec.ports).join(', ')})`); continue; }
    if (portType !== FLOW) { push(`graph.edges[${index}].port`, `port ${port} of ${edge.from} is ${portType}, not a flow port`); continue; }
    if (!('in' in to.spec.ports) && to.spec.kind !== 'trigger') { push(`graph.edges[${index}].to`, `${edge.to} accepts no incoming flow`); continue; }
    edges.push({ from: edge.from, to: edge.to, port });
  }

  // CYCLE detection over flow edges: a cycle is fine ONLY through a loop/wait node
  // (an intentional repeat); a bare cycle would spin without ever advancing time.
  const adjacency = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const edge of edges) adjacency.get(edge.from).push(edge);
  const state = new Map();
  const cycles = [];
  const visit = (id, path) => {
    state.set(id, 'visiting');
    for (const edge of adjacency.get(id) || []) {
      const next = edge.to;
      if (state.get(next) === 'visiting') {
        const cycle = [...path.slice(path.indexOf(next)), next];
        const hasPacing = cycle.some((nodeId) => ['loop', 'wait', 'trigger'].includes(nodes.get(nodeId).node.type));
        cycles.push({ cycle, paced: hasPacing });
      } else if (state.get(next) !== 'done') {
        visit(next, [...path, next]);
      }
    }
    state.set(id, 'done');
  };
  for (const id of nodes.keys()) if (state.get(id) === undefined) visit(id, [id]);
  for (const entry of cycles) {
    if (!entry.paced) push('graph.cycle', `unpaced cycle ${entry.cycle.join(' → ')} (a cycle must pass through a wait/loop/trigger so time can advance)`);
  }

  // every graph must be startable: at least one trigger
  const triggers = [...nodes.values()].filter((entry) => entry.node.type === 'trigger');
  if (triggers.length === 0) push('graph.triggers', 'a graph needs at least one trigger — nothing would ever start it');

  return {
    ok: violations.length === 0,
    violations,
    graph: {
      ...graph,
      variables: [...variables.entries()].map(([name, meta]) => ({ name, ...meta })),
      nodes: (graph.nodes || []).filter((node) => node && typeof node.id === 'string'),
      edges,
    },
    stats: { nodes: nodes.size, edges: edges.length, triggers: triggers.length, cycles: cycles.length },
  };
}

function createGraph({ id, meta = {}, variables = [], nodes = [], edges = [] }) {
  return { schemaVersion: SCHEMA_VERSION, id, meta, variables, nodes, edges };
}

module.exports = {
  ACTIONS,
  BOOL,
  FLOW,
  NODE_TYPES,
  OPERATORS,
  SCHEMA_VERSION,
  STOP_CODES,
  VALUE,
  createGraph,
  validateGraph,
};
