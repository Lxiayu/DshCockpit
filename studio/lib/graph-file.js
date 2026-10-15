'use strict';

// studio/lib/graph-file.js — reading and writing .vgraph files (UI #2's engine).
//
// A .vgraph is DATA and the interpreter validates it, so the editor may not write a graph
// the interpreter would refuse: every save validates first (schema + ports + cycles) and
// a rejected graph leaves the file byte-identical. Writes are auditable the same way the
// scene editor's are: a byte copy lands under content/build/backups/graphs/ first, and an
// unchanged graph is a no-op (无变更不落盘).
//
// Canvas positions: the interpreter does not care where a node is DRAWN, so the layout
// lives in `meta.layout` ({nodeId: {x, y}} in scene units 0..1) — presentation metadata
// inside the free-form `meta`, never part of the semantics.

const path = require('node:path');
const fs = require('node:fs');

const graphLib = require(path.join(__dirname, '..', '..', 'src', 'office', 'behavior-graph', 'index.js'));

function detectIndent(text, fallback = 2) {
  const match = /\n(\s+)"/.exec(text);
  if (!match) return fallback;
  return match[1].includes('\t') ? '\t' : match[1].length;
}

function createGraphFileService({ repoRoot, contentDir }) {
  const graphsDir = path.join(contentDir, 'graphs');
  const backupRoot = path.join(contentDir, 'build', 'backups', 'graphs');

  function list() {
    if (!fs.existsSync(graphsDir)) return { ok: true, graphs: [], dir: graphsDir };
    const graphs = fs.readdirSync(graphsDir).filter((name) => name.endsWith('.vgraph.json') || name.endsWith('.json')).sort()
      .map((name) => {
        const file = path.join(graphsDir, name);
        try {
          const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
          const outcome = graphLib.validateGraph(graph);
          return { name, file, id: graph.id || null, label: (graph.meta && graph.meta.label) || null, ok: outcome.ok, nodes: outcome.stats ? outcome.stats.nodes : null, edges: outcome.stats ? outcome.stats.edges : null, violations: outcome.violations.length };
        } catch (error) {
          return { name, file, id: null, ok: false, error: error.message };
        }
      });
    return { ok: true, graphs, dir: graphsDir };
  }

  function read({ file = null, name = null } = {}) {
    const target = file ? path.resolve(String(file)) : path.join(graphsDir, String(name));
    if (!fs.existsSync(target)) return { ok: false, code: 'GRAPH_FILE_MISSING', message: target };
    try {
      const text = fs.readFileSync(target, 'utf8');
      const graph = JSON.parse(text);
      const outcome = graphLib.validateGraph(graph);
      return { ok: true, file: target, text, graph, validation: { ok: outcome.ok, violations: outcome.violations, stats: outcome.stats || null } };
    } catch (error) {
      return { ok: false, code: 'GRAPH_UNPARSEABLE', message: error.message, file: target };
    }
  }

  // dry run by default; saveValidate validates and writes only when the graph is sound
  function save({ file = null, name = null, graph, dryRun = true, allowInvalid = false } = {}) {
    if (!graph || typeof graph !== 'object') return { ok: false, code: 'GRAPH_REQUIRED', message: 'graph is required' };
    const outcome = graphLib.validateGraph(graph);
    if (!outcome.ok && !allowInvalid) {
      return { ok: false, code: 'GRAPH_INVALID', violations: outcome.violations, stats: outcome.stats || null };
    }
    const target = file ? path.resolve(String(file)) : path.join(graphsDir, String(name));
    const existed = fs.existsSync(target);
    if (!existed) {
      if (dryRun) return { ok: true, dryRun: true, created: true, file: target, stats: outcome.stats || null };
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(graph, null, 2)}\n`);
      return { ok: true, dryRun: false, created: true, file: target, stats: outcome.stats || null };
    }
    const before = fs.readFileSync(target, 'utf8');
    const after = `${JSON.stringify(graph, null, detectIndent(before))}${before.endsWith('\n') ? '\n' : ''}`;
    if (before === after) return { ok: true, noop: true, file: target, stats: outcome.stats || null };
    if (dryRun) return { ok: true, dryRun: true, changed: true, file: target, stats: outcome.stats || null };
    fs.mkdirSync(backupRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(backupRoot, `${stamp}-${path.basename(target)}`);
    fs.copyFileSync(target, backup);
    fs.writeFileSync(target, after);
    return { ok: true, dryRun: false, changed: true, file: target, backup, stats: outcome.stats || null };
  }

  // the canvas positions live in meta.layout; this returns the graph with a moved node
  function moveNode({ graph, nodeId, x, y }) {
    const next = JSON.parse(JSON.stringify(graph));
    next.meta = next.meta || {};
    next.meta.layout = next.meta.layout || {};
    if (!next.nodes.some((node) => node.id === nodeId)) return { ok: false, code: 'GRAPH_NODE_UNKNOWN', message: nodeId };
    next.meta.layout[nodeId] = { x: Number(Math.min(1, Math.max(0, x)).toFixed(5)), y: Number(Math.min(1, Math.max(0, y)).toFixed(5)) };
    return { ok: true, graph: next };
  }

  // a deterministic starter layout for a graph that has no meta.layout yet
  function autoLayout({ graph }) {
    const kindOrder = ['trigger', 'control', 'action'];
    const columns = new Map(kindOrder.map((kind, index) => [kind, index]));
    const byColumn = new Map();
    for (const node of graph.nodes || []) {
      const spec = graphLib.NODE_TYPES[node.type];
      const kind = spec ? spec.kind : 'action';
      const column = columns.has(kind) ? columns.get(kind) : 2;
      if (!byColumn.has(column)) byColumn.set(column, []);
      byColumn.get(column).push(node);
    }
    const layout = {};
    const columnWidth = 0.32;
    for (const [column, nodes] of byColumn) {
      nodes.forEach((node, index) => {
        layout[node.id] = { x: 0.06 + column * columnWidth, y: Math.min(0.92, 0.08 + index * (0.84 / Math.max(1, nodes.length))) };
      });
    }
    return layout;
  }

  return { autoLayout, backupRoot, graphsDir, list, moveNode, read, save };
}

module.exports = { createGraphFileService, detectIndent };
