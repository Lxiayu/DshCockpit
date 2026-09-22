'use strict';

// test/office-gen-frames.test.js — M3 (2026-09-17): gen-frames pipeline pure
// parts. The CLI talks to the relay; everything testable lives here: prompt
// building (relay rejects >300 chars with 400 — IMG-GEN-KICKOFF pitfall 2),
// grid slice math, and real PNG tile slicing through the workbench
// png-geometry kernel (the same bytes the workbench validates later).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const { buildPrompt, planSliceRects, tileFileNames } = require(path.join(ROOT, 'scripts', 'gen-frames.js'));
const pngGeometry = require(path.join(ROOT, 'src', 'workbench', 'lib', 'png-geometry.js'));

test('buildPrompt stays under the relay 300-char limit and names the action', () => {
  const prompt = buildPrompt({ action: 'walk-left', mode: 'edit', count: 3, grid: '3x1' });
  assert.ok(prompt.length <= 300, `prompt must be <=300 chars, got ${prompt.length}`);
  assert.match(prompt, /walking left/i);
  assert.match(prompt, /white background/i);
  assert.match(prompt, /3 equal/i);
});

test('buildPrompt asks for the leg-tuck in-between phases for walk extension', () => {
  const prompt = buildPrompt({ action: 'walk-left', mode: 'edit', count: 3, grid: '3x1' });
  assert.match(prompt, /leg/i, 'the walk extension must explicitly ask for leg phases');
});

test('buildPrompt for rework asks for the character only, no desk or laptop', () => {
  const prompt = buildPrompt({ action: 'working-front-3q', mode: 'edit', count: 2, grid: '1x2' });
  assert.match(prompt, /no desk|character only/i);
  assert.ok(prompt.length <= 300);
});

test('planSliceRects divides a grid row into equal tiles covering the full width', () => {
  const rects = planSliceRects({ width: 1024, height: 1024, grid: '3x1' });
  assert.equal(rects.length, 3);
  assert.deepEqual(rects[0], { x: 0, y: 0, width: 341, height: 1024 });
  // coverage: tiles tile the width without gaps (last absorbs remainder)
  assert.equal(rects[2].x + rects[2].width, 1024);
  for (let i = 1; i < rects.length; i += 1) assert.equal(rects[i].x, rects[i - 1].x + rects[i - 1].width);
});

test('planSliceRects supports 2x2 grids', () => {
  const rects = planSliceRects({ width: 1024, height: 1024, grid: '2x2' });
  assert.equal(rects.length, 4);
  assert.deepEqual(rects[0], { x: 0, y: 0, width: 512, height: 512 });
  assert.deepEqual(rects[3], { x: 512, y: 512, width: 512, height: 512 });
});

test('tileFileNames numbers tiles in reading order with the action prefix', () => {
  assert.deepEqual(
    tileFileNames({ action: 'walk-left', count: 3, startIndex: 6 }),
    ['walk-left-06.png', 'walk-left-07.png', 'walk-left-08.png']
  );
});

test('real PNG slicing: a 2x2 quadrant image slices into four distinct quadrant tiles', () => {
  const img = pngGeometry.createImage(4, 4);
  const paint = (x0, y0, x1, y1, r, g, b) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * 4 + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
  };
  paint(0, 0, 2, 2, 255, 0, 0);
  paint(2, 0, 4, 2, 0, 255, 0);
  paint(0, 2, 2, 4, 0, 0, 255);
  paint(2, 2, 4, 4, 255, 255, 0);
  const png = pngGeometry.encodePng(img.data, img.width, img.height);
  const decoded = pngGeometry.decodePng(png);
  const rects = planSliceRects({ width: 4, height: 4, grid: '2x2' });
  const { slicePngBuffer } = require(path.join(ROOT, 'scripts', 'gen-frames.js'));
  const tiles = slicePngBuffer(png, rects);
  assert.equal(tiles.length, 4);
  const firstPixel = (buf) => {
    const d = pngGeometry.decodePng(buf);
    return [d.data[0], d.data[1], d.data[2]];
  };
  assert.deepEqual(firstPixel(tiles[0]), [255, 0, 0]);
  assert.deepEqual(firstPixel(tiles[1]), [0, 255, 0]);
  assert.deepEqual(firstPixel(tiles[2]), [0, 0, 255]);
  assert.deepEqual(firstPixel(tiles[3]), [255, 255, 0]);
});

test('buildDashscopePayload orders [images..., text] and converts size to 1024*1024', () => {
  const { buildDashscopePayload } = require(path.join(ROOT, 'scripts', 'gen-frames.js'));
  const payload = buildDashscopePayload({
    model: 'qwen-image-edit',
    prompt: 'x',
    imagesBase64: ['AAA', 'BBB'],
    size: '1024x1024',
  });
  assert.equal(payload.model, 'qwen-image-edit');
  assert.equal(payload.parameters.size, '1024*1024');
  const content = payload.input.messages[0].content;
  assert.equal(content.length, 3);
  assert.equal(content[0].image, 'data:image/png;base64,AAA');
  assert.equal(content[1].image, 'data:image/png;base64,BBB');
  assert.equal(content[2].text, 'x');
});

test('buildGeminiPayload puts text first then inline_data images', () => {
  const { buildGeminiPayload } = require(path.join(ROOT, 'scripts', 'gen-frames.js'));
  const payload = buildGeminiPayload({ prompt: 'p', imagesBase64: ['AAA'] });
  const parts = payload.contents[0].parts;
  assert.equal(parts[0].text, 'p');
  assert.deepEqual(parts[1].inline_data, { mime_type: 'image/png', data: 'AAA' });
});

test('buildPrompt for working-back asks for the back view with arm and head motion', () => {
  const prompt = buildPrompt({ action: 'working-back', mode: 'edit', count: 3, grid: '3x1' });
  assert.match(prompt, /back view/i);
  assert.match(prompt, /behind/i);
  assert.match(prompt, /arms/i);
  assert.match(prompt, /head/i);
  assert.ok(prompt.length <= 300);
});

test('trimBorderLines crops a full-width drawn border box to its interior', () => {
  const { trimBorderLines } = require(path.join(ROOT, 'scripts', 'gen-frames.js'));
  // 30x30 white tile with a 2px black box spanning the frame (like the model draws)
  const img = pngGeometry.createImage(30, 30, [255, 255, 255, 255]);
  const set = (x, y, v) => { const i = (y * 30 + x) * 4; img.data[i] = v; img.data[i+1] = v; img.data[i+2] = v; };
  for (let x = 0; x < 30; x += 1) { set(x, 5, 0); set(x, 6, 0); set(x, 23, 0); set(x, 24, 0); }
  for (let y = 0; y < 30; y += 1) { set(5, y, 0); set(6, y, 0); set(23, y, 0); set(24, y, 0); }
  const trimmed = trimBorderLines(img);
  assert.ok(trimmed.width < 30 && trimmed.height < 30, 'the border box is cropped away');
  // no remaining dark edge pixels (JPEG残留 clean-up expectations)
  const darkEdge = (() => {
    let dark = 0;
    for (let x = 0; x < trimmed.width; x += 1) {
      for (const y of [0, trimmed.height - 1]) {
        const i = (y * trimmed.width + x) * 4;
        if (trimmed.data[i] < 60) dark += 1;
      }
    }
    return dark;
  })();
  assert.equal(darkEdge, 0, 'edges are clean after trimming');
  assert.ok(trimmed.width >= 30 * 0.25, 'sanity floor keeps the tile');
});

test('planContentAwareRects cuts at the whitest column near each equal boundary', () => {
  const { planContentAwareRects } = require(path.join(ROOT, 'scripts', 'gen-frames.js'));
  // 90x10 white sheet, two ink strips at x=10..34 and x=56..80 → the true gap
  // is x=34..56 (min-ink col ≈45), NOT the equal-third boundary x=45... wait
  // thirds of 90 = 30/60; strip A crosses x=30 (like the tail in the real
  // sheet), so the naive equal split cuts it. The content-aware cut must find
  // the empty column instead.
  const img = pngGeometry.createImage(90, 10, [255, 255, 255, 255]);
  const ink = (x0, x1) => {
    for (let y = 0; y < 10; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * 90 + x) * 4;
        img.data[i] = 10; img.data[i + 1] = 10; img.data[i + 2] = 10;
      }
    }
  };
  ink(10, 35); // crosses the x=30 boundary
  ink(56, 81);
  const rects = planContentAwareRects(img, { cols: 3 });
  assert.equal(rects.length, 3);
  // coverage: full width, no gaps
  assert.equal(rects[0].x, 0);
  assert.equal(rects[2].x + rects[2].width, 90);
  for (let i = 1; i < rects.length; i += 1) assert.equal(rects[i].x, rects[i - 1].x + rects[i - 1].width);
  // the first cut must land in the empty gap (35..55), not at the ink edge 30
  assert.ok(rects[0].width >= 35 && rects[0].width <= 56, `first cut at ${rects[0].width} (must avoid ink)`);
});

test('flipHorizontal mirrors pixels left-right for walk-right reuse', () => {
  const { flipHorizontal } = require(path.join(ROOT, 'scripts', 'gen-frames.js'));
  const img = pngGeometry.createImage(2, 1, [0, 0, 0, 255]);
  const setPx = (x, r, g, b) => { const i = x * 4; img.data[i] = r; img.data[i+1] = g; img.data[i+2] = b; };
  setPx(0, 255, 0, 0); // left pixel red
  setPx(1, 0, 255, 0); // right pixel green
  const flipped = pngGeometry.decodePng(flipHorizontal(pngGeometry.encodePng(img.data, 2, 1)));
  assert.deepEqual([flipped.data[0], flipped.data[1], flipped.data[2]], [0, 255, 0], 'left becomes green');
  assert.deepEqual([flipped.data[4], flipped.data[5], flipped.data[6]], [255, 0, 0], 'right becomes red');
});

test('buildPrompt --single asks for a small step with legs close together (user direction 2026-09-17)', () => {
  const prompt = buildPrompt({ action: 'walk-left', mode: 'gen', count: 1, single: true });
  assert.match(prompt, /legs close together/i);
  assert.match(prompt, /small gentle step/i);
  assert.match(prompt, /side view walking left/i);
  assert.ok(prompt.length <= 300);
});

test('buildPrompt for the 摸鱼 poses: sleeping asks for the dozing back view; blink for closed eyes', () => {
  const { buildPrompt } = require(path.join(ROOT, 'scripts', 'gen-frames.js'));
  const nap = buildPrompt({ action: 'sleeping', mode: 'edit', count: 1, single: true });
  assert.match(nap, /back view/i);
  assert.match(nap, /dozing/i);
  assert.ok(nap.length <= 300);
  const blink = buildPrompt({ action: 'idle-blink', mode: 'edit', count: 1, single: true });
  assert.match(blink, /eyes/i);
  assert.ok(blink.length <= 300);
});
