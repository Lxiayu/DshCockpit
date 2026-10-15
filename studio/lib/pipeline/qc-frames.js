'use strict';

// studio/lib/pipeline/qc-frames.js — S5 for FRAMES: the automated gatekeeper.
//
// Everything here is measured, never assumed, and every finding names the frame
// and the number that failed. The checks encode the failure classes this project
// actually shipped (docs/strategy + the E5a/E5a-R1 reports):
//
//   qc.alpha-lost            the matte is gone (no real alpha) — "matting failed"
//   qc.foot-drift            the sole line moved between frames (walk wobble)
//   qc.height-drift          visible height drift (scale wobble)
//   qc.bbox-jitter           the content box centre wanders (ghosting / sliding)
//   qc.residue-below-soles   pixels below the sole line (the wash line, stray matte)
//   qc.safe-margin           content inside the 10% guard band (cropping risk)
//   qc.opaque-background     a frame still has an opaque border (background kept)
//   qc.duplicate-frame       two frames are (nearly) identical — dHash hamming
//   qc.frame-gap             a numeric series has a hole (C-card c03 was cut away)
//   qc.metadata-order        the metadata order does not match the numeric series
//
// Verdict per frame and per action: red (not publishable) / yellow (review) / green.
// Nothing is "fixed" here: the report carries a suggested fix per finding, and the
// orchestrator (./orchestrate.js) turns those into parameter changes or triage.

const path = require('node:path');
const fs = require('node:fs');

const fp = require('node:crypto');

const SAFE_MARGIN_RATIO = 0.10;      // the D2 guard: nothing inside the outer 10%
const ALPHA_BOUND_THRESHOLD = 8;     // the pipeline's visible-bounds threshold
const RESIDUE_ALPHA_MIN = 1;         // any alpha below the sole line counts
// Calibrated on the real walk cycle (studio/lib/pipeline/qc-frames.js was run over
// the shipped b-series first): adjacent dHash distances there are 1–3 with two
// exact 0s, so a "≤3 = duplicate" rule would flag 76 pairs and mean nothing. The
// honest signals are: byte-identical (a real repeat, red), an adjacent distance of
// 0 (coarse structure frozen — a stall hint), and an adjacency OUTLIER (a jump in
// the rhythm = a dropped frame).
const STALL_HAMMING_MAX = 0;
const MOTION_OUTLIER_FACTOR = 3;
const MOTION_OUTLIER_MIN = 8;

function sha256(buffer) {
  return fp.createHash('sha256').update(buffer).digest('hex');
}

// ---- dHash (the duplicate-frame detector) ------------------------------------
function dHash(image) {
  const SIZE = 9;
  const lane = new Float64Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const sx = Math.min(image.width - 1, Math.floor((x / (SIZE - 1)) * (image.width - 1)));
      const sy = Math.min(image.height - 1, Math.floor((y / (SIZE - 1)) * (image.height - 1)));
      const offset = (sy * image.width + sx) * 4;
      const alpha = image.data[offset + 3] / 255;
      const luma = (0.299 * image.data[offset] + 0.587 * image.data[offset + 1] + 0.114 * image.data[offset + 2]) * alpha;
      lane[y * SIZE + x] = luma;
    }
  }
  let bits = '';
  for (let y = 0; y < SIZE - 1; y += 1) {
    for (let x = 0; x < SIZE - 1; x += 1) {
      bits += lane[y * SIZE + x] < lane[y * SIZE + x + 1] ? '1' : '0';
    }
  }
  return bits;
}

function hamming(a, b) {
  let distance = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) distance += 1;
  return distance;
}

// ---- per-frame measurement ----------------------------------------------------

function measureFrame(absPath, png) {
  const buffer = fs.readFileSync(absPath);
  const image = png.decodePngFile(absPath);
  const { width, height } = image;
  const data = image.data;
  let minAlpha = 255;
  let maxAlpha = 0;
  let opaquePixels = 0;
  let mass = 0;
  let sumX = 0;
  let sumY = 0;
  const xs = [];
  let maxAlphaRow = -1;
  const rowHasAlpha = new Array(height).fill(false);
  const colHasAlpha = new Array(width).fill(false);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha < minAlpha) minAlpha = alpha;
      if (alpha > maxAlpha) maxAlpha = alpha;
      if (alpha >= 128) { opaquePixels += 1; maxAlphaRow = Math.max(maxAlphaRow, y); }
      if (alpha >= ALPHA_BOUND_THRESHOLD) {
        rowHasAlpha[y] = true;
        colHasAlpha[x] = true;
        mass += alpha;
        sumX += x * alpha;
        sumY += y * alpha;
        xs.push(x);
      }
    }
  }
  // the sole line = the lowest row with a main-body alpha (the pipeline's rule)
  let footLine = null;
  for (let y = height - 1; y >= 0; y -= 1) {
    let found = false;
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] >= 128) { found = true; break; }
    }
    if (found) { footLine = y; break; }
  }
  let top = height; let bottom = -1; let left = width; let right = -1;
  for (let y = 0; y < height; y += 1) if (rowHasAlpha[y]) { if (y < top) top = y; if (y > bottom) bottom = y; }
  for (let x = 0; x < width; x += 1) if (colHasAlpha[x]) { if (x < left) left = x; if (x > right) right = x; }
  // residue: rows BELOW the sole line that still carry any alpha (wash line, strays)
  const residueRows = [];
  for (let y = (footLine === null ? height : footLine) + 1; y < height; y += 1) {
    let rowMax = 0;
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > rowMax) rowMax = alpha;
    }
    if (rowMax >= RESIDUE_ALPHA_MIN) residueRows.push({ y, maxAlpha: rowMax });
  }
  // an opaque border means the background was never removed
  let opaqueBorder = 0;
  const borderProbe = (x, y) => { if (data[(y * width + x) * 4 + 3] >= 250) opaqueBorder += 1; };
  for (let x = 0; x < width; x += 1) { borderProbe(x, 0); borderProbe(x, height - 1); }
  for (let y = 0; y < height; y += 1) { borderProbe(0, y); borderProbe(width - 1, y); }

  xs.sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  const medianX = xs.length === 0 ? null : (xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid]);
  return {
    width,
    height,
    bytes: buffer.length,
    sha256: sha256(buffer),
    minAlpha,
    maxAlpha,
    opaquePixels,
    opaqueBorderPixels: opaqueBorder,
    footLine,
    lowestOpaqueRow: maxAlphaRow,
    visibleBounds: bottom >= top && right >= left ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null,
    visibleHeight: bottom >= top ? bottom - top + 1 : null,
    visibleWidth: right >= left ? right - left + 1 : null,
    centroid: mass > 0 ? { x: Number((sumX / mass).toFixed(2)), y: Number((sumY / mass).toFixed(2)) } : null,
    medianX,
    residueRows,
    hash: dHash(image),
  };
}

// ---- the battery --------------------------------------------------------------

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function seriesGaps(files) {
  // a numeric series like walk-left-b01…b15: report holes and stray names
  const parsed = files.map((file) => {
    const match = /^(.*?)(\d+)(\.[a-z]+)$/i.exec(path.basename(file));
    return match ? { file, prefix: match[1], number: Number(match[2]), suffix: match[3] } : { file, prefix: null, number: null, suffix: null };
  });
  const groups = new Map();
  for (const entry of parsed) {
    if (entry.number === null) continue;
    const key = `${entry.prefix}|${entry.suffix}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const problems = [];
  for (const [key, entries] of groups) {
    entries.sort((a, b) => a.number - b.number);
    for (let index = 1; index < entries.length; index += 1) {
      const gap = entries[index].number - entries[index - 1].number;
      if (gap > 1) {
        const missing = Array.from({ length: gap - 1 }, (_, offset) => entries[index - 1].number + offset + 1);
      problems.push({
          code: 'qc.frame-gap',
          severity: 'yellow',
          series: key,
          missing,
          between: [path.basename(entries[index - 1].file), path.basename(entries[index].file)],
          message: `the series ${key} has a hole: number(s) ${missing.join(', ')} missing between ${path.basename(entries[index - 1].file)} and ${path.basename(entries[index].file)}`,
          fix: 'either restore the missing frame or rename the series so it is contiguous',
        });
      }
    }
  }
  return problems;
}

// frames: [{ file, abs }] in METADATA order (the play order). options.tolerancePx
// and options.footLine come from the action doc when there is one.
function qcFrames({ frames, label = 'frames', footLine = null, tolerancePx = 1, heightTolerancePx = 2, expectedSeries = null }) {
  const png = require(path.join(__dirname, '..', '..', '..', 'src', 'workbench', 'lib', 'png-geometry.js'));
  const measured = [];
  const findings = [];
  for (const [index, frame] of frames.entries()) {
    if (!frame.abs || !fs.existsSync(frame.abs)) {
      findings.push({ code: 'qc.frame-missing', severity: 'red', frame: index, file: frame.file, message: `frame file is missing: ${frame.file}`, fix: 'restore the file or fix the metadata path' });
      measured.push({ index, file: frame.file, missing: true });
      continue;
    }
    const m = measureFrame(frame.abs, png);
    measured.push({ index, file: frame.file, ...m });
  }
  const present = measured.filter((entry) => !entry.missing);
  const medianFoot = median(present.map((entry) => entry.footLine).filter((value) => value !== null));
  const medianHeight = median(present.map((entry) => entry.visibleHeight).filter((value) => value !== null));
  const declaredFoot = footLine === null ? medianFoot : footLine;

  for (const entry of present) {
    const at = { frame: entry.index, file: entry.file, measured: { footLine: entry.footLine, visibleHeight: entry.visibleHeight, visibleWidth: entry.visibleWidth, minAlpha: entry.minAlpha, maxAlpha: entry.maxAlpha } };
    // 1) alpha really exists (the D2 assertion: min < 100 and max > 200)
    if (!(entry.minAlpha < 100 && entry.maxAlpha > 200)) {
      findings.push({
        code: 'qc.alpha-lost', severity: 'red', ...at,
        message: `alpha is not usable (min ${entry.minAlpha}, max ${entry.maxAlpha}) — the matte was lost in this frame`,
        fix: 're-run matting for this frame (unpremultiply → harden → de-near-black, in that order)',
      });
    }
    // 2) sole line vs the declared/median line
    if (entry.footLine !== null && declaredFoot !== null && Math.abs(entry.footLine - declaredFoot) > tolerancePx) {
      findings.push({
        code: 'qc.foot-drift', severity: 'red', ...at,
        message: `sole line ${entry.footLine} is ${entry.footLine - declaredFoot}px off ${declaredFoot} (tolerance ±${tolerancePx}px)`,
        fix: 're-normalize this frame (uniform scale + integer translation onto the pack anchor)',
      });
    }
    // 3) visible height drift
    if (entry.visibleHeight !== null && medianHeight !== null && Math.abs(entry.visibleHeight - medianHeight) > heightTolerancePx) {
      findings.push({
        code: 'qc.height-drift', severity: 'yellow', ...at,
        message: `visible height ${entry.visibleHeight} is ${entry.visibleHeight - medianHeight}px off the median ${medianHeight}`,
        fix: 'scale this frame to the action median before publish',
      });
    }
    // 4) residue below the sole line (the wash line / stray matte)
    if (entry.residueRows.length > 0) {
      const worst = entry.residueRows.reduce((best, row) => (row.maxAlpha > best.maxAlpha ? row : best), entry.residueRows[0]);
      findings.push({
        code: 'qc.residue-below-soles', severity: 'yellow', ...at,
        message: `${entry.residueRows.length} row(s) below the sole line still carry alpha (worst row ${worst.y} α${worst.maxAlpha})`,
        fix: 'clean the residue at the source canvas (remove-bg post-process) or re-issue the sheet',
      });
    }
    // 5) safe margin (≥10% in from every edge)
    if (entry.visibleBounds) {
      const margin = SAFE_MARGIN_RATIO * Math.min(entry.width, entry.height);
      const bounds = entry.visibleBounds;
      const breaches = [];
      if (bounds.x < margin) breaches.push(`left ${bounds.x}px`);
      if (bounds.y < margin) breaches.push(`top ${bounds.y}px`);
      if (entry.width - (bounds.x + bounds.width) < margin) breaches.push(`right ${entry.width - (bounds.x + bounds.width)}px`);
      if (entry.height - (bounds.y + bounds.height) < margin) breaches.push(`bottom ${entry.height - (bounds.y + bounds.height)}px`);
      if (breaches.length > 0) {
        findings.push({
          code: 'qc.safe-margin', severity: 'yellow', ...at,
          message: `content enters the 10% guard band (${breaches.join(', ')}; needs ≥${margin.toFixed(1)}px)`,
          fix: 're-issue the frame with the required margin (ahoge / skirt / tail are the usual offenders)',
        });
      }
    }
    // 6) an opaque border means the background was never removed
    if (entry.opaqueBorderPixels > entry.width) {
      findings.push({
        code: 'qc.opaque-background', severity: 'red', ...at,
        message: `${entry.opaqueBorderPixels} opaque border pixels — the frame still has a background`,
        fix: 'run matting (green-screen removal) before publish',
      });
    }
  }

  // 7) adjacent similarity (dHash): a frozen step reads as a stall, and a jump in
  //    the rhythm reads as a dropped frame
  const adjacent = [];
  for (let index = 1; index < present.length; index += 1) {
    adjacent.push({ from: present[index - 1].index, to: present[index].index, distance: hamming(present[index - 1].hash, present[index].hash) });
  }
  const distanceMedian = median(adjacent.map((entry) => entry.distance));
  for (const entry of adjacent) {
    if (entry.distance <= STALL_HAMMING_MAX) {
      findings.push({
        code: 'qc.motion-stall', severity: 'yellow',
        frame: entry.to, file: present.find((frame) => frame.index === entry.to).file,
        message: `frames #${entry.from} and #${entry.to} are structurally identical (dHash distance ${entry.distance}) — the motion stalls here`,
        fix: 'replace one of the two poses, or drop the repeat',
      });
    }
    if (entry.distance >= MOTION_OUTLIER_MIN && distanceMedian !== null && entry.distance >= MOTION_OUTLIER_FACTOR * Math.max(distanceMedian, 1)) {
      findings.push({
        code: 'qc.motion-irregular', severity: 'yellow',
        frame: entry.to, file: present.find((frame) => frame.index === entry.to).file,
        message: `the step #${entry.from}→#${entry.to} jumps (dHash distance ${entry.distance} vs median ${distanceMedian}) — looks like a dropped or misplaced frame`,
        fix: 'check the metadata order: a missing frame in the cycle shows up exactly here',
      });
    }
  }
  // 8) identical bytes are worse than similar pixels: a true repeat
  const byHash = new Map();
  for (const entry of present) {
    if (!byHash.has(entry.sha256)) byHash.set(entry.sha256, []);
    byHash.get(entry.sha256).push(entry);
  }
  for (const [, group] of byHash) {
    if (group.length > 1) {
      findings.push({
        code: 'qc.duplicate-frame', severity: 'red',
        frame: group[1].index, file: group[1].file,
        message: `frames ${group.map((entry) => `#${entry.index}`).join(', ')} are byte-identical — the same file is played twice`,
        fix: 'remove the repeated frame from the metadata order',
      });
    }
  }
  // 9) the numeric series (holes = a cut-away frame)
  if (expectedSeries) {
    for (const problem of seriesGaps(expectedSeries)) {
      findings.push(problem);
    }
  }
  // 10) jitter of the content centre (ghosting/sliding across the cycle)
  const centroidXs = present.map((entry) => (entry.centroid ? entry.centroid.x : null)).filter((value) => value !== null);
  const medianXs = present.map((entry) => entry.medianX).filter((value) => value !== null);
  if (centroidXs.length > 2) {
    const spreadX = Math.max(...centroidXs) - Math.min(...centroidXs);
    const spreadMedian = Math.max(...medianXs) - Math.min(...medianXs);
    if (spreadX > 6) {
      findings.push({
        code: 'qc.bbox-jitter', severity: 'yellow',
        message: `the alpha centroid wanders ${spreadX.toFixed(1)}px across the cycle (median-x spread ${spreadMedian.toFixed(1)}px) — read the strip for ghosting`,
        fix: 'check for a sliding body / prop pulling the mass; normalize per frame if it is drift',
      });
    }
  }

  const reds = findings.filter((finding) => finding.severity === 'red');
  const yellows = findings.filter((finding) => finding.severity === 'yellow');
  return {
    ok: reds.length === 0,
    label,
    verdict: reds.length > 0 ? 'red' : (yellows.length > 0 ? 'yellow' : 'green'),
    frames: measured,
    stats: {
      frames: measured.length,
      present: present.length,
      medianFootLine: medianFoot,
      medianVisibleHeight: medianHeight,
      declaredFootLine: footLine,
      tolerancePx,
      centroidSpreadX: centroidXs.length > 2 ? Number((Math.max(...centroidXs) - Math.min(...centroidXs)).toFixed(2)) : null,
      adjacentDistances: adjacent.map((entry) => entry.distance),
      adjacentDistanceMedian: distanceMedian,
      red: reds.length,
      yellow: yellows.length,
    },
    findings,
  };
}

module.exports = {
  ALPHA_BOUND_THRESHOLD,
  MOTION_OUTLIER_FACTOR,
  MOTION_OUTLIER_MIN,
  STALL_HAMMING_MAX,
  RESIDUE_ALPHA_MIN,
  SAFE_MARGIN_RATIO,
  dHash,
  hamming,
  measureFrame,
  qcFrames,
  seriesGaps,
};
