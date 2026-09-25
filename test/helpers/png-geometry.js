'use strict';

// test/helpers/png-geometry.js — PNG codec + alpha-geometry measurement kit.
//
// P5 (2026-09-24): moved out of src/workbench/lib with the authoring block.
// It is now pure TEST SUPPORT: the workbench tooling is gone, and the only
// remaining consumers are the office asset tests (geometry measurement) and
// the two sibling helpers below.
//
// A dependency-free PNG codec + alpha-geometry measurement kit for the
// workbench tooling (character export, publish validator, geometry report,
// golden-gallery diff). The workbench runs offline and must not grow a
// native image dependency, so decoding/encoding live here in pure JS.
//
// Scope (deliberately narrow, everything the M0 tools need and nothing else):
// - decode: 8-bit PNG, color types 0/2/3/4/6, filters 0-4, no interlace —
//   every managed production asset and every Electron capturePage PNG fits.
// - encode: RGBA (color type 6), filter 0 — used for diff overlays and
//   evidence composites only; production art is NEVER rewritten.
// - measure: alpha>=threshold shoe line (lowest opaque row), alpha>threshold
//   visible bounds, and pixel diffs between same-size images.
//
// Boundary note: this module is TOOLING. The product entry points
// (src/main.js, src/office/office.html) must never reach it — the boundary
// test in test/office-ui.test.js walks the product dependency graph to lock
// that.

const fs = require('node:fs');
const zlib = require('node:zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS_BY_COLOR_TYPE = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });

function pngError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

// ---- decode -----------------------------------------------------------------

// decodePng(buffer) -> { width, height, colorType, data:Uint8Array(RGBA) }
// Throws a stable `code`-tagged error for every unsupported/invalid input so
// validators can surface "PNG 可解码" failures without guessing.
function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw pngError('PNG_NOT_A_PNG', 'not a PNG (bad signature)');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  let palette = null;
  let trns = null;
  const idatChunks = [];
  let sawIend = false;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw pngError('PNG_TRUNCATED', 'PNG chunk overruns the buffer');
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (length < 13) throw pngError('PNG_IHDR_INVALID', 'IHDR chunk too short');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height) throw pngError('PNG_IHDR_MISSING', 'missing or empty IHDR');
  if (!sawIend && idatChunks.length === 0) throw pngError('PNG_IDAT_MISSING', 'no IDAT data');
  if (bitDepth !== 8) throw pngError('PNG_BIT_DEPTH_UNSUPPORTED', `bit depth ${bitDepth} unsupported`);
  if (interlace !== 0) throw pngError('PNG_INTERLACE_UNSUPPORTED', 'interlaced PNG unsupported');
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (!channels) throw pngError('PNG_COLOR_TYPE_UNSUPPORTED', `color type ${colorType} unsupported`);
  if (colorType === 3 && (!palette || palette.length < 3)) throw pngError('PNG_PLTE_MISSING', 'palette PNG without PLTE');

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idatChunks));
  } catch {
    throw pngError('PNG_IDAT_CORRUPT', 'IDAT zlib stream is corrupt');
  }
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw pngError('PNG_IDAT_SHORT', 'IDAT stream shorter than the pixel data');

  const pixels = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    raw.copy(line, 0, cursor, cursor + stride);
    cursor += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw pngError('PNG_FILTER_UNSUPPORTED', `scanline filter ${filter} unsupported`);
      }
      line[x] = (line[x] + predictor) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      const inX = x * channels;
      if (colorType === 6) {
        pixels[out] = line[inX];
        pixels[out + 1] = line[inX + 1];
        pixels[out + 2] = line[inX + 2];
        pixels[out + 3] = line[inX + 3];
      } else if (colorType === 2) {
        pixels[out] = line[inX];
        pixels[out + 1] = line[inX + 1];
        pixels[out + 2] = line[inX + 2];
        pixels[out + 3] = 255;
      } else if (colorType === 4) {
        const gray = line[inX];
        pixels[out] = gray;
        pixels[out + 1] = gray;
        pixels[out + 2] = gray;
        pixels[out + 3] = line[inX + 1];
      } else if (colorType === 0) {
        const gray = line[inX];
        pixels[out] = gray;
        pixels[out + 1] = gray;
        pixels[out + 2] = gray;
        pixels[out + 3] = 255;
      } else {
        const index = line[inX];
        const paletteAt = index * 3;
        pixels[out] = palette[paletteAt];
        pixels[out + 1] = palette[paletteAt + 1];
        pixels[out + 2] = palette[paletteAt + 2];
        pixels[out + 3] = trns && index < trns.length ? trns[index] : 255;
      }
    }
    line.copy(previous);
  }
  return { width, height, colorType, data: pixels };
}

function decodePngFile(absPath) {
  return decodePng(fs.readFileSync(absPath));
}

// ---- encode (RGBA, filter 0 — diff overlays / evidence composites only) ----

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// encodePng(rgba, width, height) -> Buffer (color type 6, 8-bit, filter 0)
function encodePng(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw pngError('PNG_ENCODE_SIZE', 'width/height must be positive integers');
  }
  const stride = width * 4;
  if (!Buffer.isBuffer(rgba) || rgba.length < stride * height) {
    throw pngError('PNG_ENCODE_DATA', 'rgba buffer does not cover the image');
  }
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter 0 (none)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- measurement ------------------------------------------------------------

// The lowest row with ANY alpha >= threshold (the character shoe line uses
// threshold 128 — the same rule as the pack normalization pipeline).
function lowestRowAtLeastAlpha(image, threshold = 128) {
  const { width, height, data } = image;
  for (let y = height - 1; y >= 0; y -= 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] >= threshold) return y;
    }
  }
  return null;
}

// The opaque-art bounding box, px, counting pixels with alpha > threshold
// (threshold 8 matches the contentBbox convention locked by the catalog
// tests). Returns null when the image is fully transparent.
function alphaBounds(image, threshold = 8) {
  const { width, height, data } = image;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// Pixel diff between two same-size RGBA images (golden-gallery comparison).
// changed = any channel delta > tolerance; maxDelta = the largest channel
// delta observed. Non-comparable sizes answer { comparable: false } instead
// of throwing so a report can list the mismatch.
function diffImages(a, b, tolerance = 0) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) {
    return { comparable: false, reason: 'size-mismatch', a: a && { width: a.width, height: a.height }, b: b && { width: b.width, height: b.height } };
  }
  const count = a.width * a.height * 4;
  let changedPixels = 0;
  let maxDelta = 0;
  const overlay = Buffer.alloc(count);
  for (let i = 0; i < count; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
      Math.abs(a.data[i + 3] - b.data[i + 3])
    );
    if (d > maxDelta) maxDelta = d;
    if (d > tolerance) {
      changedPixels += 1;
      // diff overlay: red where changed, on a dimmed copy of `a`
      overlay[i] = 220;
      overlay[i + 1] = 40;
      overlay[i + 2] = 40;
      overlay[i + 3] = 255;
    } else {
      const gray = (a.data[i] * 77 + a.data[i + 1] * 151 + a.data[i + 2] * 28) >> 8;
      overlay[i] = gray >> 1;
      overlay[i + 1] = gray >> 1;
      overlay[i + 2] = gray >> 1;
      overlay[i + 3] = 255;
    }
  }
  const total = a.width * a.height;
  return {
    comparable: true,
    width: a.width,
    height: a.height,
    changedPixels,
    totalPixels: total,
    diffRatio: total > 0 ? changedPixels / total : 0,
    maxDelta,
    overlay,
  };
}

// Composite `src` onto `dst` at (dstX, dstY) px, in place (evidence sheet
// compositing only).
function blit(dst, src, dstX, dstY) {
  for (let y = 0; y < src.height; y += 1) {
    const dstRow = ((dstY + y) * dst.width + dstX) * 4;
    const srcRow = y * src.width * 4;
    for (let x = 0; x < src.width * 4; x += 4) {
      const alpha = src.data[srcRow + x + 3];
      if (alpha === 0) continue;
      const d = dstRow + x;
      if (alpha === 255) {
        dst.data[d] = src.data[srcRow + x];
        dst.data[d + 1] = src.data[srcRow + x + 1];
        dst.data[d + 2] = src.data[srcRow + x + 2];
        dst.data[d + 3] = 255;
      } else {
        const inv = 255 - alpha;
        dst.data[d] = (src.data[srcRow + x] * alpha + dst.data[d] * inv) / 255;
        dst.data[d + 1] = (src.data[srcRow + x + 1] * alpha + dst.data[d + 1] * inv) / 255;
        dst.data[d + 2] = (src.data[srcRow + x + 2] * alpha + dst.data[d + 2] * inv) / 255;
        dst.data[d + 3] = Math.max(dst.data[d + 3], alpha);
      }
    }
  }
}

function createImage(width, height, fill = [255, 255, 255, 255]) {
  const data = Buffer.alloc(width * height * 4);
  if (fill) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill[0];
      data[i + 1] = fill[1];
      data[i + 2] = fill[2];
      data[i + 3] = fill[3];
    }
  }
  return { width, height, data };
}

module.exports = {
  decodePng,
  decodePngFile,
  encodePng,
  lowestRowAtLeastAlpha,
  alphaBounds,
  diffImages,
  blit,
  createImage,
};
