#!/usr/bin/env node
'use strict';

// studio/bin/graph.js — the behaviour-graph CLI (validate / run / diff / feel).
//
//   node studio/bin/graph.js validate <file.vgraph> [--json]
//   node studio/bin/graph.js run <file.vgraph> [--seed s] [--ms 200] [--steps 60] [--json]
//   node studio/bin/graph.js diff <file.vgraph> [--steps 40] [--json]   与 behavior-scheduler 对比
//   node studio/bin/graph.js feel [--json]                              手感参数与曲线取样
//
// The interpreter is the SAME module the product can import
// (src/office/behavior-graph/) — this CLI is a thin shell over it.

const path = require('node:path');
const fs = require('node:fs');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
const graphModule = require(path.join(REPO_ROOT, 'src', 'office', 'behavior-graph', 'index.js'));

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; index += 1; }
    } else positional.push(token);
  }
  return { positional, flags };
}

const USAGE = `usage:
  graph validate <file.vgraph> [--json]
  graph run <file.vgraph> [--seed s] [--ms 200] [--steps 60] [--json]
  graph diff <file.vgraph> [--steps 40] [--json]
  graph feel [--json]`;

function loadGraph(file) {
  const abs = path.resolve(String(file));
  if (!fs.existsSync(abs)) return { ok: false, code: 'GRAPH_FILE_MISSING', message: abs };
  try {
    return { ok: true, graph: JSON.parse(fs.readFileSync(abs, 'utf8')), file: abs };
  } catch (error) {
    return { ok: false, code: 'GRAPH_UNPARSEABLE', message: error.message };
  }
}

function runSchedulerStream({ steps = 40, stepMs = 1000, seed = 'office-seed-1' }) {
  const schedulerModule = require(path.join(REPO_ROOT, 'src', 'office', 'runtime', 'behavior-scheduler.js'));
  const movementModule = require(path.join(REPO_ROOT, 'src', 'office', 'runtime', 'movement-controller.js'));
  const graph = {
    version: 1,
    nodes: [
      { id: 'hall', position: { x: 0.5, y: 0.55 }, tags: ['roaming'], capacity: 4, safeRadius: 0.02 },
      { id: 'desk-1', position: { x: 0.2, y: 0.2 }, tags: ['desk', 'sleeping'], capacity: 1, safeRadius: 0.04 },
      { id: 'roam-1', position: { x: 0.25, y: 0.7 }, tags: ['roaming'], capacity: 1, safeRadius: 0.02 },
      { id: 'rest-1', position: { x: 0.15, y: 0.45 }, tags: ['resting'], capacity: 1, safeRadius: 0.02 },
      { id: 'chat-a', position: { x: 0.35, y: 0.55 }, tags: ['chatting'], capacity: 1, safeRadius: 0.02 },
    ],
    edges: [
      { from: 'hall', to: 'desk-1', behaviors: ['roaming', 'task', 'sleeping', 'chatting'], bidirectional: true },
      { from: 'hall', to: 'roam-1', behaviors: ['roaming', 'task', 'sleeping', 'chatting'], bidirectional: true },
      { from: 'hall', to: 'rest-1', behaviors: ['roaming', 'task', 'sleeping', 'chatting', 'resting'], bidirectional: true },
      { from: 'hall', to: 'chat-a', behaviors: ['roaming', 'task', 'sleeping', 'chatting'], bidirectional: true },
    ],
  };
  const clock = { nowMs: () => 0 };
  const movement = movementModule.createMovementController({ graph, clock });
  const scheduler = schedulerModule.createBehaviorScheduler({ graph, movement, clock, seed, employeeIds: ['e1', 'e2'] });
  const stream = [];
  for (let step = 0; step < steps; step += 1) {
    for (const employeeId of ['e1', 'e2']) {
      const decision = scheduler.decide({ employeeId, nowMs: step * stepMs, fromNodeId: 'hall' });
      if (decision && decision.activity) stream.push({ atMs: step * stepMs, employeeId, activity: decision.activity });
    }
  }
  return stream;
}

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];

  if (command === 'validate') {
    const loaded = loadGraph(positional[1]);
    if (!loaded.ok) { console.error(`${loaded.code}: ${loaded.message}`); return 1; }
    const outcome = graphModule.validateGraph(loaded.graph);
    if (flags.json) { console.log(JSON.stringify({ ok: outcome.ok, stats: outcome.stats || null, violations: outcome.violations }, null, 2)); return outcome.ok ? 0 : 1; }
    console.log(`${path.basename(loaded.file)} · ${outcome.ok ? 'PASS' : 'INVALID'}${outcome.stats ? ` · 节点 ${outcome.stats.nodes} / 边 ${outcome.stats.edges} / 触发器 ${outcome.stats.triggers}` : ''}`);
    for (const violation of outcome.violations) console.log(`  ✗ ${violation.check} — ${violation.detail}`);
    return outcome.ok ? 0 : 1;
  }

  if (command === 'run') {
    const loaded = loadGraph(positional[1]);
    if (!loaded.ok) { console.error(`${loaded.code}: ${loaded.message}`); return 1; }
    const seed = flags.seed ? String(flags.seed) : 'office-seed';
    const dt = flags.ms ? Number(flags.ms) : 200;
    const steps = flags.steps ? Number(flags.steps) : 60;
    const interpreter = graphModule.createInterpreter({ graph: loaded.graph, seed, clock: () => 0, employees: ['e1'] });
    if (!interpreter.ok) { console.error('GRAPH_INVALID'); for (const violation of interpreter.violations) console.error(`  ✗ ${violation.check} — ${violation.detail}`); return 1; }
    interpreter.start();
    for (let step = 0; step < steps; step += 1) interpreter.tick(dt);
    if (flags.json) { console.log(JSON.stringify({ summary: interpreter.summary(), state: interpreter.state(), trace: interpreter.trace() }, null, 2)); return 0; }
    console.log(`运行 ${path.basename(loaded.file)} · seed ${seed} · ${steps}×${dt}ms`);
    for (const entry of interpreter.trace()) {
      console.log(`  ${String(entry.atMs).padStart(6)}ms ${entry.kind}${entry.nodeId ? ` ${entry.nodeId}` : ''}${entry.do ? ` → ${entry.do}` : ''}${entry.iteration ? ` #${entry.iteration}` : ''}${entry.result !== undefined ? ` = ${entry.result}` : ''}${entry.reason ? ` (${entry.reason})` : ''}`);
    }
    console.log(`效果：${interpreter.effects().map((effect) => effect.type).join(' → ')}`);
    console.log(`变量：${JSON.stringify(interpreter.variables())}`);
    return 0;
  }

  if (command === 'diff') {
    const loaded = loadGraph(positional[1]);
    if (!loaded.ok) { console.error(`${loaded.code}: ${loaded.message}`); return 1; }
    const steps = flags.steps ? Number(flags.steps) : 40;
    const interpreter = graphModule.createInterpreter({ graph: loaded.graph, seed: 'office-seed-1', clock: () => 0, employees: ['e1', 'e2'] });
    if (!interpreter.ok) { console.error('GRAPH_INVALID'); return 1; }
    interpreter.start();
    const graphStream = [];
    for (let step = 0; step < steps; step += 1) {
      interpreter.tick(1000);
      for (const entry of graphModule.diff.streamFromInterpreterTrace(interpreter.trace())) graphStream.push(entry);
    }
    const scheduled = runSchedulerStream({ steps });
    const report = graphModule.diff.diffStreams({ scheduled, graphed: graphStream, toleranceMs: 1500 });
    if (flags.json) { console.log(JSON.stringify(report, null, 2)); return 0; }
    console.log(`差异报告 · 调度器 ${scheduled.length} 条样本 vs 图 ${graphStream.length} 条样本 · ${report.ok ? '一致' : `${report.divergences.length} 处差异`}`);
    for (const row of report.rows) {
      console.log(`  员工 ${row.employeeId}: 调度器 ${row.schedulerRuns} 段 / 图 ${row.graphRuns} 段 · 顺序${row.orderMatch ? '一致' : '不同'} · 直方图${row.histogramMatch ? '一致' : '不同'} · 最大时长差 ${row.maxDurationDeltaMs}ms`);
    }
    for (const divergence of report.divergences) console.log(`  ✗ ${divergence.kind} ${divergence.employeeId || ''} ${JSON.stringify(divergence).slice(0, 160)}`);
    console.log(`  ${report.note}`);
    return report.ok ? 0 : 0; // the diff is a REPORT: differences are data, not a failure
  }

  if (command === 'feel') {
    const feel = graphModule.feel;
    const samples = [0, 0.225, 0.45, 0.7, 1].map((progress) => ({ progress, scale: Number(feel.squashScale(progress).toFixed(4)) }));
    const table = {
      constants: { SQUASH_AMPLITUDE: feel.SQUASH_AMPLITUDE, SQUASH_MS: feel.SQUASH_MS, CROSSFADE_MS: feel.CROSSFADE_MS, leadSec: feel.DEFAULT_LEAD_SEC, tailSec: feel.DEFAULT_TAIL_SEC, OVERSHOOT_CAP: feel.OVERSHOOT_CAP },
      landing: [300, 600, 900, 1200, 1500].map((speed) => ({ speedPxPerSec: speed, scale: Number(feel.landingSquash(speed).toFixed(4)) })),
      squashCurve: samples,
      crossfade: [0, 90, 180].map((elapsedMs) => ({ elapsedMs, ...feel.crossfadeAlpha({ elapsedMs }) })),
      displacement: [0, 2, 5, 8, 10].map((currentTimeSec) => ({ currentTimeSec, ...feel.displacementForPlayback({ currentTimeSec, clipDurationSec: 10, distancePx: 200 }) })),
    };
    if (flags.json) { console.log(JSON.stringify(table, null, 2)); return 0; }
    console.log(`手感参数（借用自同行拆解，注明来源）：挤压 ${table.constants.SQUASH_AMPLITUDE}/${table.constants.SQUASH_MS}ms · 过冲上限 ${table.constants.OVERSHOOT_CAP} · 交叉淡入 ${table.constants.CROSSFADE_MS}ms · 位移 lead/tail ${table.constants.leadSec}/${table.constants.tailSec}s`);
    console.log(`挤压曲线：${table.squashCurve.map((row) => `${row.progress}→${row.scale}`).join('  ')}`);
    console.log(`落地幅度：${table.landing.map((row) => `${row.speedPxPerSec}px/s→${row.scale}`).join('  ')}`);
    console.log(`位移（10s 片、200px）：${table.displacement.map((row) => `${row.currentTimeSec}s→${row.offsetPx}px(${row.phase})`).join('  ')}`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { USAGE, main, parseArgs };
