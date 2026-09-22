'use strict';

// scripts/workbench-export-character.js — Workbench M0 scaffold generator
// (D4: the whale-girl character engineering is EXPORTED from the existing
// production pack; the old pack stays the compiled artifact / byte source
// until M4 migrates the assets).
//
// Reads  resources/characters/deepseek-default/{manifest,animations,anchors}
// + the actual frame PNGs (pure-JS alpha measurement, see
// src/workbench/lib/png-geometry.js) and writes
//         content/characters/whale-girl/character.json
//
// Deterministic by construction: no timestamps, animations in stable id
// order, frames in the pack's declared (metadata) order — re-running the
// script against an unchanged pack reproduces byte-identical output, which
// is what makes the publish validator's re-measurement meaningful.
//
// Usage:
//   node scripts/workbench-export-character.js          # (re)generate
//   node scripts/workbench-export-character.js --check  # verify only,
//                                                       # exit 1 on drift

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SOURCE_PACK = path.join(REPO_ROOT, 'resources', 'characters', 'deepseek-default');
const TARGET = path.join(REPO_ROOT, 'content', 'characters', 'whale-girl', 'character.json');

const { measureFrameFile, median, buildWalkGeometryReport } = require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'character-geometry.js'));

function directionForAction(actionId) {
  if (actionId.startsWith('walk-')) return actionId.slice('walk-'.length);
  if (actionId.startsWith('side-')) return actionId.slice('side-'.length);
  return 'front';
}

function buildCharacterJson() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE_PACK, 'manifest.json'), 'utf8'));
  const animations = JSON.parse(fs.readFileSync(path.join(SOURCE_PACK, 'animation', 'animations.json'), 'utf8'));
  const anchors = JSON.parse(fs.readFileSync(path.join(SOURCE_PACK, 'animation', 'anchors.json'), 'utf8'));
  const anchor = anchors.anchor;
  if (!anchor || !Number.isInteger(anchor.x) || !Number.isInteger(anchor.y)) {
    throw new Error('pack anchors.json is missing the calibrated top-level anchor');
  }

  // Measure every frame of every action (stable id order, declared frame
  // order inside each action — frame ORDER is data, file names never sort).
  const actionIds = Object.keys(animations.animations).sort();
  const actions = [];
  const allBounds = [];
  let canvas = null;
  for (const actionId of actionIds) {
    const declared = animations.animations[actionId];
    const frames = [];
    for (const frame of declared.frames) {
      const absFrame = path.join(SOURCE_PACK, frame.file);
      const m = measureFrameFile(absFrame);
      if (!m.ok) throw new Error(`frame ${frame.file} failed measurement: ${m.code}`);
      if (canvas === null) canvas = m.width;
      if (m.width !== canvas || m.height !== canvas) {
        throw new Error(`frame ${frame.file} breaks the square ${canvas}px canvas (${m.width}x${m.height})`);
      }
      if (m.bounds) allBounds.push(m.bounds);
      frames.push({
        file: frame.file,
        geometry: {
          footLine: m.footLine,
          visibleWidth: m.visibleWidth,
          visibleHeight: m.visibleHeight,
        },
      });
    }
    const action = {
      id: actionId,
      loop: declared.loop === true,
      direction: directionForAction(actionId),
      frames,
    };
    // The M0 geometry contract lives on the walk actions: the median shoe
    // line, the ±1px shoe / ±2px height tolerances the report flags with.
    if (actionId === 'walk-left' || actionId === 'walk-right') {
      const foots = frames.map((f) => f.geometry.footLine).filter((v) => v !== null);
      action.geometry = {
        footLine: median(foots),
        tolerancePx: 1,
        heightTolerancePx: 2,
      };
    }
    actions.push(action);
  }

  const union = {
    x: Math.min(...allBounds.map((b) => b.x)),
    y: Math.min(...allBounds.map((b) => b.y)),
  };
  union.w = Math.max(...allBounds.map((b) => b.x + b.w)) - union.x;
  union.h = Math.max(...allBounds.map((b) => b.y + b.h)) - union.y;

  return {
    schemaVersion: 1,
    id: 'whale-girl',
    label: '鲸鱼娘',
    pack: {
      canvas,
      anchor: { x: anchor.x, y: anchor.y },
      footLine: anchor.y,
      unionVisibleBounds: union,
    },
    facing: ['front', 'back', 'left', 'right'],
    defaults: {
      // The runtime walk pace is frozen (1000ms per frame) — the engineering
      // default documents it; the runtime never reads this file (M0).
      frameDurationMs: 1000,
      scale: 1,
    },
    actions,
    provenance: {
      generatedBy: 'scripts/workbench-export-character.js',
      sourcePack: 'resources/characters/deepseek-default',
      sourcePackVersion: manifest.version,
      sourcePackId: manifest.id,
      // The frame files resolve against sourcePack until M4 migrates the
      // PNG bytes into content/characters/whale-girl/assets/.
      frameRoot: 'sourcePack',
      measurement: {
        shoeAlphaThreshold: 128,
        boundsAlphaThreshold: 8,
      },
    },
  };
}

// --check verifies an existing character.json against a fresh measurement
// (the same contract the publish validator enforces).
function verifyExisting(json) {
  const problems = [];
  const resolveFrame = (_character, frame) => path.join(SOURCE_PACK, frame.file);
  const report = buildWalkGeometryReport({ character: json, resolveFramePath: resolveFrame });
  if (report.redFrames > 0) {
    problems.push(`${report.redFrames}/${report.totalFrames} walk frames red: ${report.rows.filter((r) => r.red).map((r) => r.file).join(', ')}`);
  }
  for (const action of json.actions || []) {
    for (const frame of action.frames || []) {
      const m = measureFrameFile(path.join(SOURCE_PACK, frame.file));
      const declared = frame.geometry || {};
      if (!m.ok) problems.push(`${frame.file}: ${m.code}`);
      if (m.ok && declared.footLine !== undefined && declared.footLine !== m.footLine) problems.push(`${frame.file}: footLine ${declared.footLine} != measured ${m.footLine}`);
      if (m.ok && declared.visibleHeight !== undefined && declared.visibleHeight !== m.visibleHeight) problems.push(`${frame.file}: visibleHeight ${declared.visibleHeight} != measured ${m.visibleHeight}`);
      if (m.ok && declared.visibleWidth !== undefined && declared.visibleWidth !== m.visibleWidth) problems.push(`${frame.file}: visibleWidth ${declared.visibleWidth} != measured ${m.visibleWidth}`);
    }
  }
  return problems;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  if (checkOnly) {
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
    } catch (error) {
      console.error(`workbench-export-character: cannot read ${TARGET}: ${error.message}`);
      process.exit(1);
    }
    const problems = verifyExisting(existing);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`DRIFT ${problem}`);
      process.exit(1);
    }
    console.log(`workbench-export-character: --check OK (${TARGET})`);
    return;
  }

  const json = buildCharacterJson();
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, `${JSON.stringify(json, null, 2)}\n`);
  const walkActions = json.actions.filter((a) => a.id === 'walk-left' || a.id === 'walk-right');
  console.log(`workbench-export-character: wrote ${TARGET}`);
  console.log(`  actions=${json.actions.length} walk-left=${walkActions.find((a) => a.id === 'walk-left').frames.length} frames walk-right=${walkActions.find((a) => a.id === 'walk-right').frames.length} frames`);
  console.log(`  pack=${JSON.stringify(json.pack)}`);
}

main();
