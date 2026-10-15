'use strict';

// studio/lib/scene/waypoints.js — the derived navigation graph (航点图).
//
// 原则（brief §7B）：**区域而非线条**。The graph is DERIVED, never drawn: a
// lattice of cells at `aisleWidth` spacing over the walkable region, keeping the
// cells whose centre is free for a body of `moverRadius` (plus each obstacle's
// own radius), and connecting 4-neighbours whose segment stays free. Zone labels
// come from declared `zones.regions`, workstation areas (label `work`) and the
// fallback label `roaming`; entries are the declared `zones.entries` (multiple
// entrances are supported) or, when none are declared, the free cells touching
// the walkable boundary.
//
// The result is deliberately the same shape the runtime fixture uses for its
// graph, so the studio's sampling (./conflicts.js) can reuse the runtime's own
// clearance function on it.

const { segmentFree, isFree, inWalkable, walkableBounds, labelOfPoint } = require('./zones.js');

// The runtime's own sampler (office-layout-compiler.js EDGE_SAMPLES) samples a
// segment at 1/200; the derivation below must use the SAME granularity, or the
// validator would flag edges the derivation thought were clear (and vice versa).
const EDGE_SAMPLES = 200;

function deriveWaypoints({ model, scene, workRects = [] }) {
  const bounds = walkableBounds(model);
  if (!bounds) return { ok: false, code: 'ZONES_EMPTY', nodes: [], edges: [], entries: [], stats: null };

  const step = model.aisleWidth;
  const nodes = [];
  const indexByKey = new Map();

  // Cell centres inside the walkable bounding box; the walkable test below keeps
  // only the cells that are actually walkable and free.
  const columns = Math.max(1, Math.floor((bounds.maxX - bounds.minX) / step) + 1);
  const rows = Math.max(1, Math.floor((bounds.maxY - bounds.minY) / step) + 1);
  for (let col = 0; col < columns; col += 1) {
    for (let row = 0; row < rows; row += 1) {
      const x = Math.min(bounds.minX + col * step + step / 2, bounds.maxX - 1e-6);
      const y = Math.min(bounds.minY + row * step + step / 2, bounds.maxY - 1e-6);
      const point = { x, y };
      if (!isFree(model, point, scene)) continue;
      const id = `wp-${String(col).padStart(2, '0')}-${String(row).padStart(2, '0')}`;
      const node = {
        id,
        position: { x: Number(x.toFixed(6)), y: Number(y.toFixed(6)) },
        label: labelOfPoint(model, point, { workRects, workMargin: model.aisleWidth }),
      };
      nodes.push(node);
      indexByKey.set(id, node);
    }
  }

  const edges = [];
  const edgeKeys = new Set();
  const connect = (a, b) => {
    if (!a || !b) return;
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (edgeKeys.has(key)) return;
    if (!segmentFree(model, a.position, b.position, scene, EDGE_SAMPLES)) return;
    edgeKeys.add(key);
    edges.push({ from: a.id, to: b.id });
  };
  for (const node of nodes) {
    const [colText, rowText] = node.id.replace('wp-', '').split('-');
    const col = Number(colText);
    const row = Number(rowText);
    connect(node, indexByKey.get(`wp-${String(col + 1).padStart(2, '0')}-${rowText}`));
    connect(node, indexByKey.get(`wp-${String(col - 1).padStart(2, '0')}-${rowText}`));
    connect(node, indexByKey.get(`wp-${colText}-${String(row + 1).padStart(2, '0')}`));
    connect(node, indexByKey.get(`wp-${colText}-${String(row - 1).padStart(2, '0')}`));
  }

  // entries: declared points (nearest free node) or the boundary-touching cells
  const entries = [];
  if (model.entries.length > 0) {
    for (const entry of model.entries) {
      const nearest = nearestNode(nodes, entry.point);
      entries.push({
        id: entry.id,
        source: 'declared',
        at: entry.point,
        node: nearest ? nearest.id : null,
        blocked: !isFree(model, entry.point, scene),
        label: entry.label,
      });
    }
  } else {
    const margin = step / 2 + 1e-9;
    for (const node of nodes) {
      const onEdge = node.position.x - bounds.minX <= margin || bounds.maxX - node.position.x <= margin
        || node.position.y - bounds.minY <= margin || bounds.maxY - node.position.y <= margin;
      if (onEdge) entries.push({ id: `auto-${node.id}`, source: 'derived', at: node.position, node: node.id, blocked: false, label: null });
    }
  }

  const components = connectedComponents(nodes, edges);
  const labels = {};
  for (const node of nodes) labels[node.label] = (labels[node.label] || 0) + 1;
  const isolated = components.filter((component) => component.length === 1).map((component) => component[0]);

  return {
    ok: true,
    code: null,
    nodes,
    edges,
    entries,
    labels,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      components: components.length,
      isolated: isolated.length,
      largestComponent: Math.max(0, ...components.map((component) => component.length)),
      aisleWidth: model.aisleWidth,
      moverRadius: model.moverRadius,
      grid: { columns, rows },
    },
  };
}

function nearestNode(nodes, point) {
  let best = null;
  let bestDistance = Infinity;
  for (const node of nodes) {
    const distance = (node.position.x - point.x) ** 2 + (node.position.y - point.y) ** 2;
    if (distance < bestDistance) { bestDistance = distance; best = node; }
  }
  return best;
}

function connectedComponents(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }
  const seen = new Set();
  const components = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const stack = [node.id];
    const component = [];
    seen.add(node.id);
    while (stack.length > 0) {
      const id = stack.pop();
      component.push(id);
      for (const next of adjacency.get(id) || []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    components.push(component);
  }
  return components;
}

// Reachability from an entry set over the derived graph.
function reachableFrom(nodes, edges, startIds) {
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }
  const seen = new Set();
  const stack = [...startIds].filter((id) => adjacency.has(id));
  for (const id of stack) seen.add(id);
  while (stack.length > 0) {
    const id = stack.pop();
    for (const next of adjacency.get(id) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return seen;
}

module.exports = { EDGE_SAMPLES, connectedComponents, deriveWaypoints, nearestNode, reachableFrom, inWalkable };
