#!/usr/bin/env node
'use strict';

// studio/bin/scene.js — the scene CLI (the headless form of the 场景 panel).
//
//   node studio/bin/scene.js report [--scene flat] [--json]
//   node studio/bin/scene.js waypoints [--scene flat] [--out <file>]
//   node studio/bin/scene.js sync-zones [--scene flat] [--write]
//   node studio/bin/scene.js boxes [--scene flat] [--json]
//
// `report` exits 1 when the scene has BLOCKING findings (the same gate the panel
// shows), so it can be used in a pre-commit hook or a CI step.
//
// Exit codes: 0 ok · 1 blocked/failed · 2 usage.

const path = require('node:path');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
const { createStudioServices } = require(path.join(STUDIO_ROOT, 'lib', 'studio-services.js'));

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
  scene report [--scene flat] [--json]
  scene waypoints [--scene flat] [--out <file>]
  scene sync-zones [--scene flat] [--write]
  scene boxes [--scene flat] [--json]`;

const SEVERITY_MARK = { red: '✗', yellow: '!' };

function services() {
  return createStudioServices({
    repoRoot: REPO_ROOT,
    contentDir: path.join(REPO_ROOT, 'content'),
    charactersRoot: path.join(REPO_ROOT, 'resources', 'characters'),
  });
}

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const sceneId = flags.scene ? String(flags.scene) : 'flat';
  const studio = services();

  if (command === 'report') {
    const report = studio.sceneReport({ sceneId });
    if (flags.json) { console.log(JSON.stringify(report, null, 2)); return report.ok ? 0 : 1; }
    if (!report.ok && !report.stats) { console.error(`scene unreadable: ${report.code} ${report.message || ''}`); return 1; }
    console.log(`scene ${report.sceneId} · ${report.scene.width}×${report.scene.height} · ${report.ok ? 'PASS（无阻断项）' : 'BLOCKED'}`);
    console.log(`stats: ${JSON.stringify(report.stats)}`);
    console.log(`graph: ${JSON.stringify(report.graph.stats)} labels ${JSON.stringify(report.graph.labels)} entries ${report.graph.entries.length}`);
    for (const station of report.stations) {
      console.log(`  ${station.id}: desk=${station.desk} monitor=${station.monitor} character=${station.character} chair=${station.chair}`);
    }
    for (const violation of report.violations) {
      const mark = SEVERITY_MARK[violation.severity] || '·';
      console.log(`${mark} [${violation.severity}] ${violation.code} — ${violation.message}`);
    }
    return report.ok ? 0 : 1;
  }

  if (command === 'waypoints') {
    const out = flags.out ? path.resolve(String(flags.out)) : null;
    const graph = studio.sceneWaypoints({ sceneId, write: out });
    if (!graph.ok) { console.error(`waypoints unavailable: ${graph.code || ''} ${graph.message || ''}`); return 1; }
    if (flags.json) { console.log(JSON.stringify(graph, null, 2)); return 0; }
    console.log(`waypoints ${sceneId}: ${graph.nodes.length} nodes / ${graph.edges.length} edges`);
    console.log(`labels: ${JSON.stringify(graph.labels)}`);
    console.log(`components: ${graph.stats.components} (isolated ${graph.stats.isolated}, largest ${graph.stats.largestComponent})`);
    console.log(`entries: ${graph.entries.length} (${graph.entries.filter((entry) => entry.blocked).length} blocked)`);
    if (out) console.log(`written: ${graph.written}`);
    return 0;
  }

  if (command === 'sync-zones') {
    const outcome = studio.sceneSyncZones({ sceneId, write: Boolean(flags.write) });
    if (!outcome.ok) { console.error(`sync failed: ${outcome.code} ${outcome.message || ''}`); return 1; }
    console.log(`zones ${outcome.exact ? 'already in sync' : 'drifted'} · changes: +${outcome.changes.added.length} -${outcome.changes.removed.length} ~${outcome.changes.moved.length} (=${outcome.changes.unchanged.length})`);
    if (outcome.changes.added.length) console.log(`  added:   ${outcome.changes.added.join(', ')}`);
    if (outcome.changes.moved.length) console.log(`  moved:   ${outcome.changes.moved.join(', ')}`);
    if (outcome.changes.removed.length) console.log(`  removed: ${outcome.changes.removed.join(', ')}`);
    if (flags.write) {
      console.log(outcome.noop ? 'nothing written (无变更不落盘)' : `written: ${outcome.file}${outcome.backup ? ` (backup ${outcome.backup})` : ''}`);
    } else if (!outcome.exact) {
      console.log('dry run — pass --write to update content/scenes/<scene>/zones.json');
    }
    return 0;
  }

  if (command === 'boxes') {
    const boxes = studio.sceneBoxes({ sceneId });
    if (!boxes.ok) { console.error(`boxes unavailable: ${boxes.code}`); return 1; }
    if (flags.json) { console.log(JSON.stringify(boxes, null, 2)); return 0; }
    console.log(`art boxes ${sceneId}: ${boxes.items.length} items`);
    for (const item of boxes.items) {
      console.log(`  ${item.id.padEnd(10)} ${String(item.kind).padEnd(9)} ${String(item.asset).padEnd(20)} ${item.box ? `box ${item.box.x},${item.box.y} ${item.box.width}×${item.box.height}` : 'no box'}`);
    }
    return 0;
  }

  console.error(USAGE);
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { USAGE, main, parseArgs };
