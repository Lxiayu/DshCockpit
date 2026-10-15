'use strict';

// studio/test/atlas.test.js — atlas packing (P8).
//
// The requirement is "包体显著小于全量打包", and the honest version of that claim needs
// numbers on the REAL pack plus proof that packing changes nothing visually:
//   * every PLAYED frame appears exactly once (the animations.json order is the data);
//   * a trimmed sprite round-trips PIXEL-FOR-PIXEL (decode the atlas region, compare with
//     the source frame's trim window) — a byte-count win that altered art would be a loss;
//   * the spritesheet is Pixi-shaped (frames/meta/spriteSourceSize/sourceSize/pivot);
//   * the pack is deterministic (same input ⇒ same atlas bytes);
//   * the byte ratio is reported for PNG and, when ffmpeg exists, for WebP lossless —
//     the atlas PNG is byte-parity (the win there is texture count), the WebP variant is
//     where the bytes come from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
const PACK_ROOT = path.join(REPO_ROOT, 'resources', 'characters', 'deepseek-default');

const png = require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'png-geometry.js'));
const geometry = require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'character-geometry.js'));
const { collectPlayedFrames, cropImage, packAtlas, shelfPack, nextPowerOfTwo } = require(path.join(STUDIO_ROOT, 'lib', 'atlas', 'pack.js'));

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the played-frame inventory matches the pack data exactly', () => {
  const collected = collectPlayedFrames({ packRoot: PACK_ROOT });
  assert.equal(collected.actions.length, 17, 'seventeen actions');
  assert.equal(collected.frames.length, 74, 'seventy-four played frames, each once');
  const names = collected.frames.map((frame) => frame.file);
  assert.equal(new Set(names).size, names.length, 'no duplicates in the inventory');
  const walkLeft = collected.actions.find((action) => action.actionId === 'walk-left');
  assert.equal(walkLeft.frames, 15);
  assert.equal(walkLeft.unique, 15);
});

test('the shelf packer is deterministic and never overlaps', () => {
  const items = [{ name: 'a', width: 10, height: 10 }, { name: 'b', width: 20, height: 5 }, { name: 'c', width: 8, height: 30 }, { name: 'd', width: 40, height: 12 }];
  const first = shelfPack({ items, maxWidth: 60, padding: 2 });
  const second = shelfPack({ items, maxWidth: 60, padding: 2 });
  assert.deepEqual(first, second, 'same input ⇒ same layout');
  for (let a = 0; a < first.boxes.length; a += 1) {
    for (let b = a + 1; b < first.boxes.length; b += 1) {
      const A = first.boxes[a];
      const B = first.boxes[b];
      const overlap = A.x < B.x + B.width && B.x < A.x + A.width && A.y < B.y + B.height && B.y < A.y + A.height;
      assert.equal(overlap, false, `${A.name} and ${B.name} do not overlap`);
    }
  }
  assert.equal(first.width <= 60, true, 'the width cap is honoured');
  assert.equal(nextPowerOfTwo(100), 128);
  assert.equal(nextPowerOfTwo(2048), 2048);
});

test('packing the real pack is deterministic and reports honest numbers', (t) => {
  const dir = sandbox(t);
  const first = packAtlas({ packRoot: PACK_ROOT, outDir: path.join(dir, 'a') });
  const second = packAtlas({ packRoot: PACK_ROOT, outDir: path.join(dir, 'b') });
  assert.equal(first.ok, true, `pack ok (${first.code || ''})`);
  assert.equal(first.frames, 74);
  assert.equal(first.loose.files, 74);
  assert.ok(first.atlas.width > 1000 && first.atlas.height > 1000, 'one real atlas');
  assert.equal(fs.readFileSync(first.pngPath).equals(fs.readFileSync(second.pngPath)), true, 'byte-identical across runs');
  assert.equal(fs.readFileSync(first.jsonPath).equals(fs.readFileSync(second.jsonPath)), true, 'the sheet is identical too');
  assert.ok(first.trimmedPercent > 25 && first.trimmedPercent < 60, `trim keeps the useful pixels only (${first.trimmedPercent}%)`);
  // the byte story, stated as measured: PNG parity, texture count 74 → 1
  assert.ok(first.ratio >= 1, `the atlas PNG is never bigger than the loose files (${first.ratio}×)`);
  assert.ok(first.ratio < 1.3, `PNG parity is reported, not inflated (${first.ratio}×)`);
});

test('a trimmed sprite round-trips pixel-for-pixel', (t) => {
  const dir = sandbox(t);
  const report = packAtlas({ packRoot: PACK_ROOT, outDir: dir });
  assert.equal(report.ok, true);
  const sheet = JSON.parse(fs.readFileSync(report.jsonPath, 'utf8'));
  const atlas = png.decodePngFile(report.pngPath);
  const names = Object.keys(sheet.frames);
  // spot-check across action families: a single-frame expression, a walk frame, the
  // side poses and the working-back loop
  const samples = [
    'assets/expressions/idle.png',
    'assets/animations/walk/left/walk-left-b05.png',
    'assets/animations/side/none/side-back.png',
    names.find((name) => name.includes('working-back')) || names[0],
  ];
  for (const name of samples) {
    const entry = sheet.frames[name];
    assert.ok(entry, `${name} is in the sheet`);
    const source = png.decodePngFile(path.join(PACK_ROOT, name));
    const trimmed = cropImage(source, { x: entry.spriteSourceSize.x, y: entry.spriteSourceSize.y, w: entry.frame.w, h: entry.frame.h });
    for (let y = 0; y < entry.frame.h; y += 1) {
      for (let x = 0; x < entry.frame.w; x += 1) {
        const a = (y * entry.frame.w + x) * 4;
        const b = ((entry.frame.y + y) * atlas.width + entry.frame.x + x) * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          if (trimmed.data[a + channel] !== atlas.data[b + channel]) {
            assert.fail(`${name} differs at (${x},${y}) channel ${channel}: ${trimmed.data[a + channel]} vs ${atlas.data[b + channel]}`);
          }
        }
      }
    }
    // the trim window really is the alpha bounds the measurement reports
    const measured = geometry.measureFrameFile(path.join(PACK_ROOT, name));
    assert.deepEqual({ x: measured.bounds.x, y: measured.bounds.y, w: measured.bounds.w, h: measured.bounds.h },
      { x: entry.spriteSourceSize.x, y: entry.spriteSourceSize.y, w: entry.frame.w, h: entry.frame.h },
      `${name} trim == measured alpha bounds`);
  }
});

test('the spritesheet is Pixi-shaped and keeps the pack anchors', () => {
  const report = packAtlas({ packRoot: PACK_ROOT, dryRun: true });
  const sheet = report.sheet;
  assert.ok(sheet.frames && sheet.meta, 'frames + meta');
  assert.equal(sheet.meta.size.w, report.atlas.width);
  assert.equal(sheet.meta.padding, 2);
  const entry = sheet.frames['assets/animations/walk/left/walk-left-b05.png'];
  for (const key of ['frame', 'rotated', 'trimmed', 'spriteSourceSize', 'sourceSize', 'pivot', 'outputAnchor']) {
    assert.ok(key in entry, `frame entries carry ${key}`);
  }
  assert.equal(entry.sourceSize.w, 352, 'the original canvas size is recorded');
  assert.equal(entry.outputAnchor.x, 178, 'the pack anchor travels with the sprite');
  // the pivot is the anchor expressed in trimmed-sprite coordinates
  const pivotX = (entry.outputAnchor.x - entry.spriteSourceSize.x) / entry.frame.w;
  assert.ok(Math.abs(entry.pivot.x - pivotX) < 1e-6, 'the pivot is consistent with the trim window');
});

test('the WebP variant is the measured byte win (and degrades honestly without ffmpeg)', (t) => {
  const dir = sandbox(t);
  const report = packAtlas({ packRoot: PACK_ROOT, outDir: dir, format: 'webp' });
  assert.equal(report.ok, true);
  if (!report.webp || !report.webp.ok) {
    // no ffmpeg here: the tool must say so instead of pretending
    assert.ok(report.webp && report.webp.code, `a stable code explains the skip (${JSON.stringify(report.webp)})`);
    return;
  }
  assert.ok(report.webp.bytes < report.loose.bytes * 0.8, `WebP lossless is a real win (${report.webp.ratio}× vs loose PNG)`);
  const sheet = JSON.parse(fs.readFileSync(report.jsonPath, 'utf8'));
  assert.equal(sheet.meta.image, 'whale-girl-atlas.webp', 'the sheet points at the encoded image');
  assert.equal(sheet.meta.format, 'WEBP');
  assert.equal(fs.existsSync(report.webp.path), true);
});
