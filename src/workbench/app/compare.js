'use strict';

// src/workbench/app/compare.js — the EDIT/RUN comparison model (workbench UX
// rectification, gap #3: 运行层可观测性).
//
// The runtime picture is the product's own render, and until now the only way to
// see WHERE an employee walks was the edit layer's own 行走点 drawing — which is
// hidden the moment you switch to 运行. This module is the model half of the
// comparison layer: it folds the DERIVED navigation graph, the workstations and
// the LIVE employee positions into one set of pixel coordinates in the scene's
// own space, so the renderer can draw them as an overlay on the runtime picture
// and the two layers can be read against each other.
//
// Deliberately pure: no DOM, no SVG, no IPC. The inputs are what the services
// already return (sceneWaypoints' nodes/edges are NORMALIZED 0..1, the employees
// from the preview status are normalized too), the output is plain numbers, and
// every coordinate is clamped into the scene so a stale snapshot can never draw
// outside the world.

// The scene's logical size, in pixels. The stage follows the scene's own
// announce()d size; the comparison layer is only built once a scene is loaded,
// and a missing width/height falls back to the flat scene's 1280×840 rather
// than dividing by zero.
const SCENE_FALLBACK = Object.freeze({ width: 1280, height: 840 });

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Normalized (0..1) → pixels, clamped into the scene. A position of 1.0001
// (float drift in a pushed snapshot) draws at the edge, not outside it.
function toPx(point, width, height) {
  return {
    x: Math.min(width, Math.max(0, num(point && point.x) * width)),
    y: Math.min(height, Math.max(0, num(point && point.y) * height)),
  };
}

function buildCompareModel({ nodes = [], edges = [], stations = [], employees = [], width, height } = {}) {
  const w = Number.isFinite(Number(width)) && Number(width) > 0 ? Number(width) : SCENE_FALLBACK.width;
  const h = Number.isFinite(Number(height)) && Number(height) > 0 ? Number(height) : SCENE_FALLBACK.height;

  const nodeById = new Map();
  const modelNodes = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || node.id === undefined || node.id === null) continue;
    const at = toPx(node.position || node, w, h);
    nodeById.set(String(node.id), at);
    modelNodes.push({ id: String(node.id), x: at.x, y: at.y });
  }
  // an edge whose endpoint is missing from the node list is dropped, not guessed
  const modelEdges = [];
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!edge) continue;
    const from = nodeById.get(String(edge.from));
    const to = nodeById.get(String(edge.to));
    if (!from || !to) continue;
    modelEdges.push({ from: String(edge.from), to: String(edge.to), x1: from.x, y1: from.y, x2: to.x, y2: to.y });
  }
  const modelStations = [];
  for (const station of Array.isArray(stations) ? stations : []) {
    if (!station) continue;
    const at = toPx(station.position || station, w, h);
    modelStations.push({ id: String(station.id ?? ''), x: at.x, y: at.y });
  }
  const modelEmployees = [];
  for (const employee of Array.isArray(employees) ? employees : []) {
    if (!employee || !employee.position) continue;
    const at = toPx(employee.position, w, h);
    modelEmployees.push({ id: String(employee.employeeId ?? employee.id ?? ''), x: at.x, y: at.y });
  }

  return {
    width: w,
    height: h,
    nodes: modelNodes,
    edges: modelEdges,
    stations: modelStations,
    employees: modelEmployees,
    summary: () => ({
      nodes: modelNodes.length,
      edges: modelEdges.length,
      stations: modelStations.length,
      employees: modelEmployees.length,
    }),
  };
}

const wbCompareApi = { SCENE_FALLBACK, buildCompareModel };
// dual module (the house pattern, see i18n.js): require()-able from Node AND
// loadable as a classic script in the page.
if (typeof window !== 'undefined') window.wbCompare = wbCompareApi;
if (typeof module !== 'undefined' && module.exports) module.exports = wbCompareApi;
