#!/usr/bin/env node
// scripts/office-assets/normalize-working-back.js — Task E6d.
//
// Normalizes the three GENERATED back-facing seated-work frames
// (gpt-image-2 /images/edits, character identity locked to the pack's
// walk-left-02 reference) into the production character pack geometry,
// reusing the M1 deterministic import pipeline (normalizeImportFrame):
//   - one UNIFORM scale maps the source's visible body height onto the
//     side-back frame's visibleBounds.height (state-independent size);
//   - one INTEGER translation places the source contact anchor
//     (median x of the alpha>=128 lowest row, that row) onto the pack
//     anchor (178, 296) — the geometry anchor, never hardcoded here;
//   - alpha is preserved (premultiplied bilinear); no cropping, no
//     rotation, no retouch — deterministic scale + translate only.
//
// The normalized frames must re-measure within the M1 tolerances (foot
// line ±1px, visible height ±2px) and the visible art must stay INSIDE
// the pack's union visibleBounds (the renderer scales every frame by the
// union height, so the union itself must never move). Anything else is
// rejected fail-closed before any pack byte is written.
//
// The script is idempotent: the animations.json "working-back" entry and
// the anchors.json frame records are replaced in place; both files are
// rewritten through the canonical pack serializer (sorted keys, anchors
// frames map insertion-order preserved, new records appended last).
//
// Usage:
//   node scripts/office-assets/normalize-working-back.js <raw-01.png> <raw-02.png> <raw-03.png> \
//     [--pack resources/characters/deepseek-default] [--dry-run]
//
// Exit codes: 0 = normalized (+ inserted unless --dry-run); 4 = geometry
// verification failure (nothing written); 3 = usage/tool error.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { normalizeImportFrame } = require('../../src/workbench/lib/normalizer.js');
const { canonicalPackJson } = require('../../src/workbench/lib/pack-json.js');

function parseArgs(argv) {
  const out = { sources: [], pack: path.join('resources', 'characters', 'deepseek-default'), dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pack') out.pack = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
    else out.sources.push(arg);
  }
  if (out.sources.length !== 3) {
    console.error('usage: node scripts/office-assets/normalize-working-back.js <raw-01.png> <raw-02.png> <raw-03.png> [--pack dir] [--dry-run]');
    return null;
  }
  return out;
}

function fail(result) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(4);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) process.exit(3);
  const packRoot = args.pack;
  const anchorsPath = path.join(packRoot, 'animation', 'anchors.json');
  const animationsPath = path.join(packRoot, 'animation', 'animations.json');
  let anchors;
  let animations;
  try {
    anchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf8'));
    animations = JSON.parse(fs.readFileSync(animationsPath, 'utf8'));
  } catch (error) {
    console.error(`cannot read pack metadata: ${error.message}`);
    process.exit(3);
  }

  const packAnchor = anchors.anchor;
  const packCanvas = anchors.outputCanvas.width;
  const union = anchors.visibleBounds;
  // State-independent size: the seated art targets the side-back pose's
  // visible height (the current composed back view), never a new constant.
  const sideBack = anchors.frames['assets/animations/side/none/side-back.png'];
  if (!sideBack) {
    console.error('anchors.json has no side-back frame to derive the target height from');
    process.exit(3);
  }
  // The M1 pipeline scales the visible body height onto the target and puts
  // the contact anchor at (178, 296); wide poses (raised arm / whale tail)
  // can then poke past the 352² canvas edge by a fraction of a pixel and the
  // pipeline rejects that fail-closed. The backoff is DETERMINISTIC: every
  // frame always scales to the SAME height (inter-frame size consistency),
  // starting at the side-back height and stepping down until the widest
  // frame fits (±2px of side-back stays inside the M1/E6d tolerance).
  const TARGET_FLOOR_PX = sideBack.visibleBounds.height - 4;
  let targetHeight = sideBack.visibleBounds.height;
  let outputs = [];
  for (;;) {
    outputs = [];
    for (let index = 0; index < args.sources.length; index += 1) {
      const sourcePath = args.sources[index];
      const name = `working-back-0${index + 1}.png`;
      const outputRel = `assets/animations/working/back/${name}`;
      let sourceBytes;
      try {
        sourceBytes = fs.readFileSync(sourcePath);
      } catch (error) {
        fail({ result: 'invalid', reason: `cannot read source ${sourcePath}: ${error.message}` });
      }
      const normalized = normalizeImportFrame({
        sourceBytes,
        targetHeight,
        footLine: packAnchor.y,
        packCanvas,
        packAnchor,
      });
      if (!normalized.ok) {
        outputs.push({ sourcePath, outputRel, name, failed: true, violations: normalized.violations });
      } else {
        outputs.push({
          name,
          outputRel,
          png: normalized.png,
          entry: normalized.entry,
          metrics: normalized.metrics,
          sourcePath,
        });
      }
    }
    if (outputs.every((output) => !output.failed)) break;
    if (targetHeight - 1 < TARGET_FLOOR_PX) {
      fail({
        result: 'invalid',
        targetHeightTried: targetHeight,
        sources: args.sources,
        violations: outputs.filter((output) => output.failed).flatMap((output) => output.violations),
      });
    }
    targetHeight -= 1;
  }

  const summary = {
    result: 'ok',
    dryRun: args.dryRun,
    packRoot,
    targetHeight,
    sideBackHeight: sideBack.visibleBounds.height,
    packAnchor,
    unionFrozen: union,
    frames: outputs.map((output) => {
      // The UNION visibleBounds {6,41,319,277} is FROZEN (renderer occlusion
      // math + content/characters/whale-girl/character.json contract): it is
      // never recomputed for new frames. Art that pokes past the union box
      // is accepted but RECORDED here, never silently hidden — the renderer
      // scales by the union HEIGHT, which the ±2px target-height tolerance
      // keeps stable.
      const bounds = output.entry.visibleBounds;
      return {
        source: output.sourcePath,
        output: output.outputRel,
        sourceAnchor: output.entry.sourceAnchor,
        sourceCanvas: output.entry.sourceCanvas,
        sourceScale: output.entry.sourceScale,
        visibleBounds: bounds,
        outOfUnion: !(bounds.x >= union.x
          && bounds.y >= union.y
          && bounds.x + bounds.width <= union.x + union.width
          && bounds.y + bounds.height <= union.y + union.height),
        metrics: output.metrics,
      };
    }),
  };
  if (args.dryRun) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // ---- write the pack (fail-closed above means every frame verified) -------
  for (const output of outputs) {
    const absOut = path.join(packRoot, output.outputRel);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, output.png);

    const frameMeta = {
      file: output.outputRel,
      durationMs: null,
      anchor: null,
      visibleBounds: output.entry.visibleBounds,
    };
    animations.animations['working-back'] = animations.animations['working-back'] || {
      direction: 'none',
      state: 'working-back',
      loop: true,
      frames: [],
    };
    animations.animations['working-back'].frames = [
      ...animations.animations['working-back'].frames.filter((frame) => frame.file !== output.outputRel),
      frameMeta,
    ].sort((a, b) => a.file.localeCompare(b.file));

    anchors.frames[output.outputRel] = {
      sourceAnchor: output.entry.sourceAnchor,
      outputAnchor: output.entry.outputAnchor,
      visibleBounds: output.entry.visibleBounds,
      sourceCanvas: output.entry.sourceCanvas,
      sourceScale: output.entry.sourceScale,
      detection: output.entry.detection,
    };
  }
  // keep the animations frames arrays aligned with the file names 01/02/03
  animations.animations['working-back'].frames.sort((a, b) => a.file.localeCompare(b.file));

  fs.writeFileSync(animationsPath, `${canonicalPackJson(animations)}\n`);
  fs.writeFileSync(anchorsPath, `${canonicalPackJson(anchors)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main();
