// frame-hygiene.js — strips the baked-in "art box" guide line from character
// frames at texture-load time.
//
// The normalized character pack (resources/characters/<pack>) was exported
// with a 1px, near-white, semi-transparent rectangle drawn exactly on the
// declared visibleBounds perimeter (alpha ≈ 70–102, RGB ≥ 250). On the light
// office it is invisible; on the dark code scene it reads as a ghost box
// around every character. The line is part of the PNG, not a renderer
// artifact: the sprite, its interpolation offset and the depth sort are all
// correct.
//
// Geometry is NOT touched here: animations.json stays the sole bounds
// authority and the sprite keeps sampling the full texture. Only the ring's
// alpha is cleared, and only where the pixel is a faint near-white — real art
// that happens to touch the box edge (opaque or saturated) is left alone.
//
// Pure pixel math so the office page and the Node tests share one definition.

const GUIDE_MAX_ALPHA = 128;
const GUIDE_MIN_CHANNEL = 240;

function isGuidePixel(r, g, b, a) {
  return a > 0 && a < GUIDE_MAX_ALPHA
    && r >= GUIDE_MIN_CHANNEL && g >= GUIDE_MIN_CHANNEL && b >= GUIDE_MIN_CHANNEL;
}

// Clears the 1px ring on the perimeter of `bounds` (texture pixels). `data` is
// an RGBA buffer of `width * height` pixels — an ImageData.data array or any
// Uint8ClampedArray. Returns the number of cleared pixels.
function stripGuideRing(data, width, bounds) {
  if (!data || !width || !bounds) return 0;
  const x0 = Math.trunc(bounds.x);
  const y0 = Math.trunc(bounds.y);
  const x1 = x0 + Math.trunc(bounds.width) - 1;
  const y1 = y0 + Math.trunc(bounds.height) - 1;
  if (!(x0 >= 0 && y0 >= 0 && x1 >= x0 && y1 >= y0)) return 0;
  const height = Math.floor(data.length / 4 / width);
  if (x1 >= width || y1 >= height) return 0;

  let cleared = 0;
  const clear = (x, y) => {
    const i = (y * width + x) * 4;
    if (isGuidePixel(data[i], data[i + 1], data[i + 2], data[i + 3])) {
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0;
      cleared += 1;
    }
  };
  for (let x = x0; x <= x1; x += 1) {
    clear(x, y0);
    if (y1 !== y0) clear(x, y1);
  }
  for (let y = y0 + 1; y < y1; y += 1) {
    clear(x0, y);
    if (x1 !== x0) clear(x1, y);
  }
  return cleared;
}

module.exports = {
  stripGuideRing,
  isGuidePixel,
  GUIDE_MAX_ALPHA,
  GUIDE_MIN_CHANNEL,
};
