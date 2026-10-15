'use strict';

// studio/lib/atlas/pack.js — atlas packing (P8): one PNG + a PixiJS spritesheet JSON
// instead of a folder of 352² canvases that are mostly transparent.
//
// The pack's frames are all drawn on the same square canvas with the character occupying
// the middle, so a large fraction of every file is empty alpha. Trimming each frame to its
// measured alpha bounds and packing the trimmed rectangles is therefore a pure win in
// bytes; the spritesheet JSON keeps the ORIGINAL canvas size and the pivot (the pack's
// outputAnchor) so a renderer can place a trimmed sprite exactly where the untrimmed one
// would have been — no visual change, less data.
//
// Deterministic: frames are packed in the animation order, rows are packed left to right,
// so the same input always produces the same atlas (the size is chosen from the content,
// not tuned by hand).

const path = require('node:path');
const fs = require('node:fs');

const TOOL_ROOT = path.resolve(__dirname, '..', '..', '..');
const png = require(path.join(TOOL_ROOT, 'src', 'workbench', 'lib', 'png-geometry.js'));
const geometry = require(path.join(TOOL_ROOT, 'src', 'workbench', 'lib', 'character-geometry.js'));

const PADDING = 2;          // transparent gutter so bilinear sampling cannot bleed
const MAX_ATLAS_WIDTH = 2048;

// png-geometry's blit copies a WHOLE image at a position and createImage fills white by
// default, so the trim window is cut out first and the atlas is created transparent.
function cropImage(image, rect) {
  const out = png.createImage(rect.w, rect.h, [0, 0, 0, 0]);
  for (let y = 0; y < rect.h; y += 1) {
    const srcRow = ((rect.y + y) * image.width + rect.x) * 4;
    const dstRow = y * rect.w * 4;
    image.data.copy(out.data, dstRow, srcRow, srcRow + rect.w * 4);
  }
  return out;
}

// A verbatim copy: png-geometry's blit ALPHA-BLENDS over the destination (it exists for
// compositing diff overlays), which turned a semi-transparent pixel [253,253,250,102] into
// [101,101,100,102] when stamped onto a transparent atlas — the pixel round-trip test
// caught it. An atlas must copy RGBA unchanged.
function stampImage(dst, src, dstX, dstY) {
  for (let y = 0; y < src.height; y += 1) {
    const srcRow = y * src.width * 4;
    const dstRow = ((dstY + y) * dst.width + dstX) * 4;
    src.data.copy(dst.data, dstRow, srcRow, srcRow + src.width * 4);
  }
}

function nextPowerOfTwo(value) {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

// Every frame the pack PLAYS, deduped, in animation order (the order IS the pack's data).
function collectPlayedFrames({ packRoot }) {
  const animationsPath = path.join(packRoot, 'animation', 'animations.json');
  const anchorsPath = path.join(packRoot, 'animation', 'anchors.json');
  const animations = JSON.parse(fs.readFileSync(animationsPath, 'utf8'));
  const anchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf8'));
  const seen = new Set();
  const frames = [];
  const actions = [];
  for (const [actionId, entry] of Object.entries(animations.animations || {})) {
    const files = [];
    for (const frame of entry.frames || []) {
      const file = typeof frame === 'string' ? frame : frame.file;
      files.push(file);
      if (seen.has(file)) continue;
      seen.add(file);
      frames.push({ file, actionId, anchor: (anchors.frames && anchors.frames[file] && anchors.frames[file].outputAnchor) || null });
    }
    actions.push({ actionId, frames: files.length, unique: new Set(files).size });
  }
  return { frames, actions, animationsPath, anchorsPath };
}

// A shelf packer: deterministic, and good enough because trimming already removed the
// waste. `items` are {name, width, height} in arrival order.
function shelfPack({ items, maxWidth = MAX_ATLAS_WIDTH, padding = PADDING }) {
  const boxes = [];
  let shelfY = 0;
  let shelfHeight = 0;
  let cursorX = 0;
  let width = 0;
  for (const item of items) {
    const w = item.width + padding;
    const h = item.height + padding;
    if (cursorX > 0 && cursorX + w > maxWidth) {
      shelfY += shelfHeight;
      shelfHeight = 0;
      cursorX = 0;
    }
    boxes.push({ name: item.name, x: cursorX, y: shelfY, width: item.width, height: item.height });
    cursorX += w;
    shelfHeight = Math.max(shelfHeight, h);
    width = Math.max(width, cursorX);
  }
  const height = shelfY + shelfHeight;
  return { boxes, width, height };
}

// Measured on the real pack (74 played frames): the atlas PNG is byte-parity with the
// loose PNGs (1.04×) because PNG already compresses each frame well; the win is (a) ONE
// texture instead of 74 (upload, bind and draw-call cost), and (b) the format upgrade the
// atlas unlocks — WebP lossless lands at 3.53 MiB vs 5.38 MiB loose (1.52×) and Chromium
// decodes it natively. Both numbers are reported, never just the flattering one.
function encodeWebp({ pngBytes, outPath, ffmpegPath = null }) {
  const { execFileSync } = require('node:child_process');
  const ffmpeg = ffmpegPath || (() => {
    try { return execFileSync('/usr/bin/which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch { return null; }
  })();
  if (!ffmpeg) return { ok: false, code: 'ATLAS_WEBP_UNAVAILABLE', message: 'ffmpeg is not on PATH' };
  const work = require('node:os').tmpdir();
  const sourcePng = path.join(work, `atlas-${process.pid}.png`);
  fs.writeFileSync(sourcePng, pngBytes);
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePng, '-c:v', 'libwebp', '-lossless', '1', '-compression_level', '6', outPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, bytes: fs.statSync(outPath).size, path: outPath };
  } catch (error) {
    return { ok: false, code: 'ATLAS_WEBP_FAILED', message: String(error.message).slice(0, 200) };
  } finally {
    fs.rmSync(sourcePng, { force: true });
  }
}

function packAtlas({
  packRoot,
  outDir,
  characterId = 'whale-girl',
  maxWidth = MAX_ATLAS_WIDTH,
  dryRun = false,
  sourceDirOverride = null,
  format = 'png',
}) {
  const collected = collectPlayedFrames({ packRoot });
  // animations.json frame paths are PACK-relative and already carry `assets/` (the same
  // rule publishAction uses: resolveFramePath = join(packRoot, frame.file)); joining
  // `assets/` again reported all 74 frames missing.
  const assetsRoot = sourceDirOverride || packRoot;
  const measured = [];
  const missing = [];
  for (const frame of collected.frames) {
    const abs = path.join(assetsRoot, frame.file);
    if (!fs.existsSync(abs)) { missing.push(frame.file); continue; }
    const m = geometry.measureFrameFile(abs);
    if (!m.ok || !m.bounds) { missing.push(frame.file); continue; }
    const image = png.decodePngFile(abs);
    measured.push({
      name: frame.file,
      actionId: frame.actionId,
      anchor: frame.anchor,
      abs,
      image,
      // the alpha bounds the measurement reports are the trim window
      trim: { x: m.bounds.x, y: m.bounds.y, w: m.bounds.w, h: m.bounds.h },
      sourceSize: { w: image.width, h: image.height },
    });
  }
  if (missing.length > 0) {
    return { ok: false, code: 'ATLAS_FRAMES_MISSING', missing: missing.slice(0, 8), total: missing.length };
  }

  const packed = shelfPack({ items: measured.map((entry) => ({ name: entry.name, width: entry.trim.w, height: entry.trim.h })), maxWidth });
  const atlasW = packed.width;
  const atlasH = packed.height;
  const atlas = png.createImage(atlasW, atlasH, [0, 0, 0, 0]);

  const boxes = new Map(packed.boxes.map((box) => [box.name, box]));
  for (const entry of measured) {
    const box = boxes.get(entry.name);
    // cut the trimmed window, then copy it verbatim at the shelf position
    stampImage(atlas, cropImage(entry.image, entry.trim), box.x, box.y);
  }

  const atlasBytes = png.encodePng(atlas.data, atlasW, atlasH);
  const looseBytes = measured.reduce((sum, entry) => sum + fs.statSync(entry.abs).size, 0);

  const sheet = {
    frames: {},
    meta: {
      app: 'studio/atlas',
      version: '1',
      image: `${characterId}-atlas.png`,
      format: 'RGBA8888',
      size: { w: atlasW, h: atlasH },
      scale: '1',
      // the pack contract, so a renderer can place sprites exactly as before
      packCanvas: measured.length > 0 ? measured[0].sourceSize.w : null,
      padding: PADDING,
    },
  };
  for (const entry of measured) {
    const box = boxes.get(entry.name);
    sheet.frames[entry.name] = {
      frame: { x: box.x, y: box.y, w: entry.trim.w, h: entry.trim.h },
      rotated: false,
      trimmed: entry.trim.x !== 0 || entry.trim.y !== 0 || entry.trim.w !== entry.sourceSize.w || entry.trim.h !== entry.sourceSize.h,
      spriteSourceSize: { x: entry.trim.x, y: entry.trim.y, w: entry.trim.w, h: entry.trim.h },
      sourceSize: { w: entry.sourceSize.w, h: entry.sourceSize.h },
      // the pivot in trimmed-sprite coordinates (what a renderer needs to keep the feet
      // and the horizontal centre where the untrimmed frame had them)
      pivot: entry.anchor
        ? { x: Number(((entry.anchor.x - entry.trim.x) / entry.trim.w).toFixed(6)), y: Number(((entry.anchor.y - entry.trim.y) / entry.trim.h).toFixed(6)) }
        : null,
      outputAnchor: entry.anchor,
      actionId: entry.actionId,
    };
  }

  const report = {
    ok: true,
    characterId,
    frames: measured.length,
    actions: collected.actions.length,
    atlas: { width: atlasW, height: atlasH, bytes: atlasBytes.length, powerOfTwo: { w: nextPowerOfTwo(atlasW), h: nextPowerOfTwo(atlasH) } },
    loose: { bytes: looseBytes, files: measured.length },
    ratio: Number((looseBytes / atlasBytes.length).toFixed(2)),
    trimmedPercent: Number((100 * measured.reduce((sum, entry) => sum + (entry.trim.w * entry.trim.h) / (entry.sourceSize.w * entry.sourceSize.h), 0) / measured.length).toFixed(1)),
  };
  if (dryRun) return { ...report, dryRun: true, sheet, png: atlasBytes };

  const target = outDir || path.join(packRoot, 'atlas');
  fs.mkdirSync(target, { recursive: true });
  const pngPath = path.join(target, `${characterId}-atlas.png`);
  const jsonPath = path.join(target, `${characterId}-atlas.json`);
  fs.writeFileSync(pngPath, atlasBytes);
  let webp = null;
  if (format === 'webp') {
    const webpPath = path.join(target, `${characterId}-atlas.webp`);
    webp = encodeWebp({ pngBytes: atlasBytes, outPath: webpPath });
    if (webp.ok) {
      sheet.meta.image = `${characterId}-atlas.webp`;
      sheet.meta.format = 'WEBP';
      report.webp = { ok: true, bytes: webp.bytes, ratio: Number((looseBytes / webp.bytes).toFixed(2)), path: webpPath };
    } else {
      report.webp = webp;
    }
  }
  fs.writeFileSync(jsonPath, `${JSON.stringify(sheet, null, 2)}\n`);
  return { ...report, pngPath, jsonPath, outDir: target, format };
}

module.exports = { MAX_ATLAS_WIDTH, PADDING, collectPlayedFrames, cropImage, encodeWebp, nextPowerOfTwo, packAtlas, shelfPack, stampImage };
