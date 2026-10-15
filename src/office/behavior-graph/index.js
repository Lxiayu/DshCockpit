'use strict';

// src/office/behavior-graph/index.js — the behaviour-graph module surface.
//
// Everything here is PURE (no DOM, no Electron, no filesystem, no wall clock): the
// studio's preview runner imports it, and the product may import the very same
// files — that is why the module lives under src/office instead of in the tool.
//
//   const { createInterpreter, validateGraph, feel, diff } = require('./behavior-graph');
//
// A .vgraph file is { schemaVersion, id, meta, variables, nodes, edges }; validate it
// with validateGraph() before storing it (an unvalidated graph must never be saved),
// run it with createInterpreter({ graph, seed, clock, employees }) and compare runs
// with diff.diffStreams().

const schema = require('./schema.js');
const interpreter = require('./interpreter.js');
const feel = require('./feel.js');
const diff = require('./diff.js');

module.exports = {
  // schema / validation
  SCHEMA_VERSION: schema.SCHEMA_VERSION,
  ACTIONS: schema.ACTIONS,
  NODE_TYPES: schema.NODE_TYPES,
  OPERATORS: schema.OPERATORS,
  createGraph: schema.createGraph,
  validateGraph: schema.validateGraph,
  // interpreter
  createInterpreter: interpreter.createInterpreter,
  xmur3: interpreter.xmur3,
  mulberry32: interpreter.mulberry32,
  // feel layer
  feel,
  // diff report
  diff,
};
