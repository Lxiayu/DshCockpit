'use strict';

// Task 2 / SPEC-02 — character pack contract tests (validator + fixture pack).
// RED: src/office/runtime/validate-character-pack.js and the generated
// fixture do not exist yet.
//
// Geometry authority rules under test:
// - manifest.json allows exactly the nine SPEC-02 top-level fields
// - animation/anchors.json is the sole geometry authority
// - animation/animations.json is the sole frame order/timing authority
// - inline conflicts (frames vs anchors) are PACK_GEOMETRY_CONFLICT
// - walk-frame foot anchors within a direction stay within ±1px
// - trim/rotate atlas metadata, unsafe paths, missing license, oversized or
//   missing assets, and executable content are rejected with stable codes

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const FIXTURE_PACK = path.join(ROOT, 'src', 'office', 'fixtures', 'character-pack');
const BUILTIN_PACK = path.join(ROOT, 'resources', 'characters', 'deepseek-default');

let validator;
try {
  validator = require(path.join(ROOT, 'src', 'office', 'runtime', 'validate-character-pack.js'));
} catch (error) {
  validator = null;
}

// ---------------------------------------------------------------------------
// deterministic minimal PNG writer (no external dependencies)
// ---------------------------------------------------------------------------

function crc32Of(buffer) {
  return zlib.crc32(buffer) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32Of(body), 0);
  return Buffer.concat([len, body, crc]);
}

// Draws a deterministic sprite: an opaque rounded "body" block whose lowest
// opaque row is `footY`, centered on `footX` (± drift), on a transparent
// background. Returns PNG bytes.
function makeSpritePng({ width = 64, height = 64, footX = 32, footY = 60, color = [40, 90, 200, 255], bodyTop = 20 } = {}) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  let off = 0;
  for (let y = 0; y < height; y += 1) {
    raw[off] = 0; // filter type 0
    off += 1;
    for (let x = 0; x < width; x += 1) {
      const inBody = y >= bodyTop && y <= footY && Math.abs(x - footX) <= 10;
      if (inBody) {
        raw[off] = color[0];
        raw[off + 1] = color[1];
        raw[off + 2] = color[2];
        raw[off + 3] = color[3];
      } else {
        raw[off] = 0;
        raw[off + 1] = 0;
        raw[off + 2] = 0;
        raw[off + 3] = 0;
      }
      off += 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function writePack(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function baseManifest() {
  return {
    schemaVersion: 1,
    id: 'test-pack',
    version: '1.0.0',
    author: 'DshCockpit test',
    license: 'MIT (test fixture)',
    runtimeCompatibility: { schema: 1 },
    geometry: 'animation/anchors.json',
    animations: 'animation/animations.json',
    fallback: { allowStaticPose: true, allowProgrammaticEmphasis: true },
  };
}

function baseAnchors({ anchor = { x: 32, y: 60 }, frames = {} } = {}) {
  return {
    schemaVersion: 1,
    sourceCanvas: { width: 64, height: 64 },
    outputCanvas: { width: 64, height: 64 },
    outputScale: 1,
    anchor,
    visibleBounds: { x: 22, y: 20, width: 20, height: 40 },
    frames,
  };
}

function frameEntry(file, { anchor, visibleBounds } = {}) {
  return {
    file,
    durationMs: null,
    anchor: anchor || null,
    visibleBounds: visibleBounds || { x: 22, y: 20, width: 20, height: 40 },
  };
}

function baseAnimations({ animations } = {}) {
  return {
    schemaVersion: 1,
    defaultFrameDurationMs: 1000,
    animations:
      animations ||
      {
        idle: { state: 'idle', direction: 'none', loop: true, frames: [frameEntry('assets/expressions/idle.png')] },
        working: { state: 'working', direction: 'none', loop: false, frames: [frameEntry('assets/expressions/working.png')] },
        'walk-left': { state: 'walk', direction: 'left', loop: true, frames: [frameEntry('assets/animations/walk/left/walk-01.png')] },
        'walk-right': { state: 'walk', direction: 'right', loop: true, frames: [frameEntry('assets/animations/walk/right/walk-01.png')] },
        'walk-up': { state: 'walk', direction: 'up', loop: true, frames: [frameEntry('assets/animations/walk/up/walk-01.png')] },
        'walk-down': { state: 'walk', direction: 'down', loop: true, frames: [frameEntry('assets/animations/walk/down/walk-01.png')] },
      },
  };
}

function goodPackFiles({ frameAnchorDriftPx = 0 } = {}) {
  const walkAnchor = { x: 32 + frameAnchorDriftPx, y: 60 };
  const driftAnchor = { x: 32, y: 60 };
  return {
    'manifest.json': JSON.stringify(baseManifest()),
    'animation/anchors.json': JSON.stringify(
      baseAnchors({
        frames: {
          'assets/animations/walk/left/walk-01.png': { sourceAnchor: { x: 32, y: 60 }, outputAnchor: driftAnchor, visibleBounds: { x: 22, y: 20, width: 20, height: 40 } },
          'assets/animations/walk/left/walk-02.png': { sourceAnchor: { x: 32, y: 60 }, outputAnchor: walkAnchor, visibleBounds: { x: 22, y: 20, width: 20, height: 40 } },
        },
      })
    ),
    'animation/animations.json': JSON.stringify(
      baseAnimations({
        animations: {
          idle: { state: 'idle', direction: 'none', loop: true, frames: [frameEntry('assets/expressions/idle.png')] },
          working: { state: 'working', direction: 'none', loop: false, frames: [frameEntry('assets/expressions/working.png')] },
          'walk-left': {
            state: 'walk',
            direction: 'left',
            loop: true,
            frames: [
              frameEntry('assets/animations/walk/left/walk-01.png', { anchor: driftAnchor }),
              frameEntry('assets/animations/walk/left/walk-02.png', { anchor: walkAnchor }),
            ],
          },
          'walk-right': { state: 'walk', direction: 'right', loop: true, frames: [frameEntry('assets/animations/walk/right/walk-01.png')] },
          'walk-up': { state: 'walk', direction: 'up', loop: true, frames: [frameEntry('assets/animations/walk/up/walk-01.png')] },
          'walk-down': { state: 'walk', direction: 'down', loop: true, frames: [frameEntry('assets/animations/walk/down/walk-01.png')] },
        }
      })
    ),
    'assets/expressions/idle.png': makeSpritePng(),
    'assets/expressions/working.png': makeSpritePng({ color: [30, 140, 80, 255] }),
    'assets/animations/walk/left/walk-01.png': makeSpritePng(),
    'assets/animations/walk/left/walk-02.png': makeSpritePng(),
    'assets/animations/walk/right/walk-01.png': makeSpritePng(),
    'assets/animations/walk/up/walk-01.png': makeSpritePng(),
    'assets/animations/walk/down/walk-01.png': makeSpritePng(),
    LICENSE: 'MIT (test fixture)\n',
    NOTICE: 'deterministic test fixture\n',
  };
}

function inTemp(rel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-pack-test-'));
  return path.join(dir, rel);
}

// ---------------------------------------------------------------------------
// validator contract tests on synthetic packs
// ---------------------------------------------------------------------------

test('validator module exists and is dependency-free', () => {
  assert.ok(validator, 'src/office/runtime/validate-character-pack.js must exist');
  const src = fs.readFileSync(path.join(ROOT, 'src', 'office', 'runtime', 'validate-character-pack.js'), 'utf8');
  assert.doesNotMatch(src, /require\(\s*['"](?!\.\/|\.\/|node:)[^'"]+\)/, 'only relative/node: requires');
  assert.match(src, /['"]use strict['"]/);
});

test('a well-formed pack validates with result passed', () => {
  const packPath = inTemp('pack');
  writePack(packPath, goodPackFiles());
  const outcome = validator.validateCharacterPack(packPath);
  assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
  assert.equal(outcome.result, 'passed');
});

test('conflicting inline geometry between animations.json and anchors.json is rejected', () => {
  const packPath = inTemp('pack');
  const files = goodPackFiles();
  const animations = JSON.parse(files['animation/animations.json']);
  animations.animations['walk-left'].frames[0].anchor = { x: 40, y: 60 };
  files['animation/animations.json'] = JSON.stringify(animations);
  writePack(packPath, files);
  const outcome = validator.validateCharacterPack(packPath);
  assert.equal(outcome.ok, false);
  assert.ok(
    outcome.errors.some((e) => e.code === 'PACK_GEOMETRY_CONFLICT'),
    JSON.stringify(outcome.errors)
  );
});

test('walk-frame anchors drifting beyond ±1px inside one direction are rejected', () => {
  const packPath = inTemp('pack');
  const files = goodPackFiles({ frameAnchorDriftPx: 3 });
  writePack(packPath, files);
  const outcome = validator.validateCharacterPack(packPath);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some((e) => e.code === 'PACK_GEOMETRY_INVALID'), JSON.stringify(outcome.errors));
});

test('unknown manifest top-level fields and inline geometry duplicates are rejected', () => {
  const packPath = inTemp('pack-a');
  const files = goodPackFiles();
  const manifest = JSON.parse(files['manifest.json']);
  manifest.preview = 'assets/expressions/idle.png'; // unknown top-level field
  files['manifest.json'] = JSON.stringify(manifest);
  writePack(packPath, files);
  let outcome = validator.validateCharacterPack(packPath);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some((e) => e.code === 'PACK_MANIFEST_INVALID'));

  const packPath2 = inTemp('pack-b');
  const files2 = goodPackFiles();
  const manifest2 = JSON.parse(files2['manifest.json']);
  manifest2.anchor = { x: 32, y: 60 }; // inline geometry duplicate
  files2['manifest.json'] = JSON.stringify(manifest2);
  writePack(packPath2, files2);
  outcome = validator.validateCharacterPack(packPath2);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some((e) => e.code === 'PACK_MANIFEST_INVALID'));
});

test('trim/rotate atlas metadata anywhere in the pack metadata is rejected', () => {
  const packPath = inTemp('pack');
  const files = goodPackFiles();
  const anchors = JSON.parse(files['animation/anchors.json']);
  anchors.frames['assets/animations/walk/left/walk-01.png'].rotate = false; // atlas flag
  files['animation/anchors.json'] = JSON.stringify(anchors);
  writePack(packPath, files);
  const outcome = validator.validateCharacterPack(packPath);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some((e) => e.code === 'PACK_GEOMETRY_INVALID'), JSON.stringify(outcome.errors));
});

test('absolute and traversal paths are rejected', () => {
  const packPath = inTemp('pack-abs');
  const files = goodPackFiles();
  const animations = JSON.parse(files['animation/animations.json']);
  animations.animations['walk-left'].frames[0].file = '/etc/passwd.png';
  files['animation/animations.json'] = JSON.stringify(animations);
  writePack(packPath, files);
  let outcome = validator.validateCharacterPack(packPath);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some((e) => e.code === 'PACK_UNSAFE_ARCHIVE' || e.code === 'PACK_MANIFEST_INVALID'));

  const packPath2 = inTemp('pack-trav');
  const files2 = goodPackFiles();
  const anchors2 = JSON.parse(files2['animation/anchors.json']);
  anchors2.frames['assets/animations/walk/left/walk-01.png'] = {
    sourceAnchor: { x: 32, y: 60 },
    outputAnchor: { x: 32, y: 60 },
    visibleBounds: { x: 22, y: 20, width: 20, height: 40 },
    file: '../escape.png',
  };
  files2['animation/anchors.json'] = JSON.stringify(anchors2);
  writePack(packPath2, files2);
  outcome = validator.validateCharacterPack(packPath2);
  assert.equal(outcome.ok, false);
});

test('missing license metadata and missing required files are rejected', () => {
  const packPath = inTemp('pack-nolicense');
  const files = goodPackFiles();
  delete files.LICENSE;
  writePack(packPath, files);
  let outcome = validator.validateCharacterPack(packPath);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some((e) => e.code === 'PACK_MANIFEST_INVALID' || e.code === 'PACK_ASSET_MISSING'));

  const packPath2 = inTemp('pack-nofile');
  const files2 = goodPackFiles();
  delete files2['assets/animations/walk/down/walk-01.png'];
  writePack(packPath2, files2);
  outcome = validator.validateCharacterPack(packPath2);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some((e) => e.code === 'PACK_ASSET_MISSING'));
});

test('oversized PNG declarations are rejected with PACK_ASSET_TOO_LARGE', () => {
  const packPath = inTemp('pack');
  const files = goodPackFiles();
  const anchors = JSON.parse(files['animation/anchors.json']);
  anchors.outputCanvas = { width: 8192, height: 8192 };
  anchors.outputScale = 128;
  files['animation/anchors.json'] = JSON.stringify(anchors);
  writePack(packPath, files);
  const outcome = validator.validateCharacterPack(packPath);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some((e) => e.code === 'PACK_ASSET_TOO_LARGE' || e.code === 'PACK_GEOMETRY_INVALID'));
});

test('executable content in a pack is rejected as unsafe', () => {
  const packPath = inTemp('pack');
  const files = goodPackFiles();
  files['assets/animations/walk/left/evil.js'] = 'module.exports = () => {};\n';
  writePack(packPath, files);
  const outcome = validator.validateCharacterPack(packPath);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some((e) => e.code === 'PACK_UNSAFE_ARCHIVE'));
});

test('missing optional states warn with ANIMATION_CAPABILITY_MISSING but stay valid', () => {
  const packPath = inTemp('pack');
  const files = goodPackFiles();
  const animations = JSON.parse(files['animation/animations.json']);
  delete animations.animations.working; // optional state
  files['animation/animations.json'] = JSON.stringify(animations);
  delete files['assets/expressions/working.png'];
  writePack(packPath, files);
  const outcome = validator.validateCharacterPack(packPath);
  assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
  assert.ok(
    (outcome.capabilitiesMissing || []).includes('working'),
    JSON.stringify(outcome.capabilitiesMissing)
  );
});

// ---------------------------------------------------------------------------
// generated fixture pack and built-in fallback pack
// ---------------------------------------------------------------------------

test('manifest identity fields must be safe single path components', () => {
  const cases = [
    { id: '../escaped', version: '1.0.0' },
    { id: '/absolute', version: '1.0.0' },
    { id: 'pack', version: '../outside' },
    { id: 'C:\\evil', version: '1.0.0' },
    { id: 'pack/x', version: '1.0.0' },
    { id: '.hidden', version: '1.0.0' },
    { id: '', version: '1.0.0' },
  ];
  for (const [index, override] of cases.entries()) {
    const packPath = inTemp(`pack-id-${index}`);
    const files = goodPackFiles();
    const manifest = JSON.parse(files['manifest.json']);
    Object.assign(manifest, override);
    files['manifest.json'] = JSON.stringify(manifest);
    writePack(packPath, files);
    const outcome = validator.validateCharacterPack(packPath);
    assert.equal(outcome.ok, false, `expected rejection for ${JSON.stringify(override)}`);
    assert.ok(
      outcome.errors.some((e) => e.code === 'PACK_MANIFEST_INVALID'),
      `expected PACK_MANIFEST_INVALID for ${JSON.stringify(override)}: ${JSON.stringify(outcome.errors)}`
    );
  }
});

test('generated whale-girl fixture pack carries an immutable, self-consistent validation report', () => {
  const reportPath = path.join(FIXTURE_PACK, 'validation-report.json');
  if (!fs.existsSync(reportPath)) {
    assert.fail('validation-report.json missing: run scripts/office-assets/normalize-character.py first');
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.schemaVersion, 1);
  assert.ok(['passed', 'invalid'].includes(report.result), report.result);
  assert.ok(report.sourceCanvas && report.outputCanvas && Number.isFinite(report.outputScale));
  assert.ok(report.threshold && report.threshold.tolerancePx <= 1);
  // every required walk direction reports its per-frame anchors and deltas
  assert.ok(report.frames && Object.keys(report.frames).length >= 16, 'walk frames recorded');
  for (const key of ['walk-left', 'walk-right', 'walk-up', 'walk-down']) {
    const frames = Object.entries(report.frames).filter(([file]) => file.includes(`/walk/${key.split('-')[1]}/`));
    assert.ok(frames.length >= 4, `${key} frames present in report`);
  }
  if (report.result === 'invalid') {
    assert.ok(
      Array.isArray(report.failures) && report.failures.length > 0,
      'invalid report must name the exact frames requiring art rework'
    );
  }
  // walk frames either pass the ±1px rule or the pack is explicitly invalid.
  // anchorDeltaPx records the ORIGINAL source drift (art review input); the
  // enforced metric after deterministic alignment is verifiedDeltaPx.
  const walkEntries = Object.values(report.frames).filter((f) => f.state === 'walk' && f.direction);
  const bad = walkEntries.filter((f) => f.status === 'passed' && f.verifiedDeltaPx > 1);
  assert.deepEqual(bad, [], 'a passed frame may not exceed the ±1px tolerance');
});

test('generated fixture pack passes the validator exactly when its report passes', () => {
  if (!fs.existsSync(path.join(FIXTURE_PACK, 'validation-report.json'))) {
    assert.fail('fixture pack missing: run the normalizer first');
  }
  const outcome = validator.validateCharacterPack(FIXTURE_PACK);
  const report = JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK, 'validation-report.json'), 'utf8'));
  assert.equal(outcome.ok, report.result === 'passed', JSON.stringify(outcome.errors));
});

test('validator never writes into the pack (validation-report.json stays immutable)', () => {
  if (!fs.existsSync(path.join(FIXTURE_PACK, 'validation-report.json'))) {
    assert.fail('fixture pack missing: run the normalizer first');
  }
  const before = fs.readFileSync(path.join(FIXTURE_PACK, 'validation-report.json'));
  validator.validateCharacterPack(FIXTURE_PACK);
  const after = fs.readFileSync(path.join(FIXTURE_PACK, 'validation-report.json'));
  assert.ok(before.equals(after), 'validation-report.json must not be modified by validation');
});

test('built-in deepseek-default fallback pack is a valid pack', () => {
  if (!fs.existsSync(path.join(BUILTIN_PACK, 'manifest.json'))) {
    assert.fail('deepseek-default pack missing');
  }
  const outcome = validator.validateCharacterPack(BUILTIN_PACK);
  assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
  const manifest = JSON.parse(fs.readFileSync(path.join(BUILTIN_PACK, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'deepseek-default');
  assert.ok(fs.existsSync(path.join(BUILTIN_PACK, 'LICENSE')));
  assert.ok(fs.existsSync(path.join(BUILTIN_PACK, 'NOTICE')));
});

// ---------------------------------------------------------------------------
// Task 5 — production whale character pack (rectangle placeholders replaced)
// ---------------------------------------------------------------------------

const BUILTIN_ASSETS = path.join(BUILTIN_PACK, 'assets');
const assetPack = require('../src/office/runtime/asset-pack.js');
const { execFileSync } = require('node:child_process');

function builtinPack() {
  return assetPack.createAssetPack({
    manifest: JSON.parse(fs.readFileSync(path.join(BUILTIN_PACK, 'manifest.json'), 'utf8')),
    anchors: JSON.parse(fs.readFileSync(path.join(BUILTIN_PACK, 'animation', 'anchors.json'), 'utf8')),
    animations: JSON.parse(fs.readFileSync(path.join(BUILTIN_PACK, 'animation', 'animations.json'), 'utf8')),
  }).pack;
}

// The deterministic diagnostic silhouettes that shipped as the original
// deepseek-default sprites. They must never come back once real art lands.
const FORBIDDEN_RECTANGLE_SHA256 = Object.freeze(new Set([
  '0b9d245b7429bd317763edd03660eae4628378fda014a6e56125bf4d99b75e3c',
  'fa685127250588c8e49525a60022d04539ee6e4fd7aac7add09c8e3c1ec98580',
  '3ff164b8737d18f846e47e31926b14a288ac21a277a359c1646d776ae1247c0c',
  'f2dcbc41276ebca42c2b1b071aa1ce3593555e9d28701e8f85b6fabec19fa982',
  '9ffcc4d5a09324fc82b4b001b0c887a0b02285ec480adca990502d60702bcf27',
]));

function productionPngFiles() {
  const files = [];
  for (const entry of walkPackAssets(BUILTIN_ASSETS)) files.push(entry);
  return files;
}

function walkPackAssets(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) out.push(...walkPackAssets(abs));
    else if (name.endsWith('.png')) out.push(abs);
  }
  return out;
}

test('production deepseek-default no longer ships the rectangle placeholder sprites', () => {
  const { createHash } = require('node:crypto');
  const files = productionPngFiles();
  assert.ok(files.length >= 9, 'production pack still ships sprites');
  for (const file of files) {
    const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(
      FORBIDDEN_RECTANGLE_SHA256.has(hash), false,
      `${path.relative(BUILTIN_PACK, file)} is still the flat diagnostic rectangle`
    );
  }
});

test('production character frames are real art, not flat single-color fills', () => {
  const files = productionPngFiles();
  assert.ok(files.length >= 9);
  const script = [
    'import json, sys',
    'from PIL import Image',
    'result = {}',
    'for p in sys.argv[1:]:',
    '    img = Image.open(p).convert("RGBA")',
    '    result[p] = len(set(img.getdata()))',
    'print(json.dumps(result))',
  ].join('\n');
  const report = JSON.parse(execFileSync('python3', ['-c', script, ...files], { encoding: 'utf8' }));
  for (const [file, distinctColors] of Object.entries(report)) {
    assert.ok(distinctColors > 64, `${path.relative(BUILTIN_PACK, file)} looks like a flat fill (${distinctColors} colors)`);
  }
});

test('every walk direction ships its own dedicated multi-frame sequence', () => {
  const animations = JSON.parse(fs.readFileSync(path.join(BUILTIN_PACK, 'animation', 'animations.json'), 'utf8')).animations;
  const filesByDirection = {};
  for (const direction of ['left', 'right', 'up', 'down']) {
    const entry = Object.values(animations).find((candidate) => candidate.state === 'walk' && candidate.direction === direction);
    assert.ok(entry, `walk-${direction} declared`);
    assert.ok(entry.frames.length >= 4, `walk-${direction} uses the existing multi-frame sequence`);
    filesByDirection[direction] = entry.frames.map((frame) => frame.file);
  }
  // 2026-09-22 二代序列（方案B：AI 视频 → RVM 抠像 → 后处理）：四个方向都是
  // 逐帧序列；帧全部互异（left/right/down 15、up 14）。旧 M3 的"刻意重复帧"
  // 手法只存在于被替换掉的随机抽卡素材里。
  const expectedCounts = { left: 15, right: 15, up: 14, down: 15 };
  for (const direction of ['left', 'right', 'up', 'down']) {
    assert.equal(filesByDirection[direction].length, expectedCounts[direction], `walk-${direction} carries ${expectedCounts[direction]} frames`);
    assert.equal(new Set(filesByDirection[direction]).size, expectedCounts[direction], `walk-${direction} frames are all distinct`);
    assert.deepEqual(filesByDirection[direction].map((f) => f.split('/').pop()),
      Array.from({ length: expectedCounts[direction] }, (_, i) => `walk-${direction}-b${String(i + 1).padStart(2, '0')}.png`),
      `walk-${direction} plays b01..b${String(expectedCounts[direction]).padStart(2, '0')} in order`);
  }
  for (const file of filesByDirection.right) {
    assert.equal(filesByDirection.left.includes(file), false, 'left and right walks never share a frame file');
  }
  // 左右走是两段独立生成的视频（方案B），不是旧 M3 的"逐字节镜像"关系；
  // 它们只需要帧数一致、几何同一（鞋线/可见高由发布内核按方向中位数校验）。
  assert.equal(filesByDirection.left.length, filesByDirection.right.length, 'left and right carry the same frame count');
  const { measureFrameFile } = require('../src/workbench/lib/character-geometry.js');
  const measureMedianHeight = (files) => {
    const heights = files.map((file) => measureFrameFile(path.join(BUILTIN_PACK, file)).visibleHeight).sort((a, b) => a - b);
    return heights[Math.floor(heights.length / 2)];
  };
  const leftHeight = measureMedianHeight(filesByDirection.left);
  const rightHeight = measureMedianHeight(filesByDirection.right);
  assert.ok(Math.abs(leftHeight - rightHeight) <= 2, `left/right share the visible height (±2px: ${leftHeight} vs ${rightHeight})`);
});

test('production anchors keep one shared foot anchor across idle and every walk direction', () => {
  const pack = builtinPack();
  const anchor = pack.geometry.anchor;
  for (const resource of ['idle', 'walk-left', 'walk-right', 'walk-up', 'walk-down']) {
    const frame = pack.frameGeometry(resource, 0);
    assert.deepEqual(frame.outputAnchor, anchor, `${resource} shares the pack foot anchor`);
    assert.deepEqual(frame.outputCanvas, pack.geometry.outputCanvas, `${resource} shares the pack canvas`);
  }
});

test('optional states without dedicated art resolve through the stable static fallback chain', () => {
  const pack = builtinPack();
  const dedicated = pack.resolve({ state: 'working' });
  assert.equal(dedicated.code, 'RESOLVED');
  assert.equal(dedicated.frameCount, 1, 'working stays the static single-frame pose');
  const completed = pack.resolve({ state: 'completed' });
  assert.equal(completed.fallbackReason, 'STATIC_POSE_FALLBACK');
  assert.equal(completed.resource, 'finished');
  const failed = pack.resolve({ state: 'failed' });
  assert.equal(failed.fallbackReason, 'STATIC_POSE_FALLBACK');
  assert.equal(failed.resource, 'error');
  // 2026-09-17: the pack now ships a dedicated sleeping pose (摸鱼 nap frame),
  // so the sleeping state resolves directly instead of falling back to idle
  const sleeping = pack.resolve({ state: 'sleeping' });
  assert.equal(sleeping.fallbackReason, null);
  assert.equal(sleeping.resource, 'sleeping');
});

test('production pack declares no photo, fixture or rejected-frame references', () => {
  for (const file of ['manifest.json', 'animation/anchors.json', 'animation/animations.json']) {
    const text = fs.readFileSync(path.join(BUILTIN_PACK, file), 'utf8');
    assert.equal(/photo\//.test(text), false, `${file} must not reference the photo tree`);
    assert.equal(/fixtures\//.test(text), false, `${file} must not reference the test fixture pack`);
    assert.equal(/front-3q/.test(text), false, `${file} must not reference geometry-rejected frames`);
  }
});

// ---------------------------------------------------------------------------
// Walk sequence (2026-09-22 二代：AI 视频 → RVM 抠像 → 后处理，83ms/帧).
// ---------------------------------------------------------------------------

test('walk: the four directions carry the 2026-09-22 sequence at the 83ms gait pace', () => {
  const animations = JSON.parse(fs.readFileSync(path.join(BUILTIN_PACK, 'animation', 'animations.json'), 'utf8'));
  const anchors = JSON.parse(fs.readFileSync(path.join(BUILTIN_PACK, 'animation', 'anchors.json'), 'utf8'));
  // left/right/down 15 帧；up 14 帧（44 帧周期隔帧取半 13 帧 + 用户定稿收束帧）
  const expected = { left: 15, right: 15, up: 14, down: 15 };
  for (const direction of ['left', 'right', 'up', 'down']) {
    const entry = animations.animations[`walk-${direction}`];
    const files = entry.frames.map((frame) => frame.file);
    assert.equal(entry.frames.length, expected[direction], `walk-${direction} has ${expected[direction]} frames`);
    assert.deepEqual(files, Array.from({ length: expected[direction] }, (_, i) =>
      `assets/animations/walk/${direction}/walk-${direction}-b${String(i + 1).padStart(2, '0')}.png`),
      'metadata order is the b01.. sequence');
    // rhythm: every frame declares the 83ms gait pace
    for (const frame of entry.frames) {
      assert.equal(frame.durationMs, 83, 'every walk frame runs at the 83ms gait pace');
      assert.doesNotMatch(frame.file, /passing|-[c]\d/, 'no legacy card/passing frame in the sequence');
    }
    // geometry: each frame has an anchors.json record, is a real 352x352 RGBA
    // PNG sharing the pack foot anchor, and the visible height matches within ±2px
    const heights = [];
    for (const file of files) {
      const declared = anchors.frames[file];
      assert.ok(declared, `${file} has an anchors.json entry`);
      assert.deepEqual(declared.outputAnchor, anchors.anchor, `${file} shares the pack foot anchor`);
      const header = fs.readFileSync(path.join(BUILTIN_PACK, file));
      assert.equal(header.readUInt32BE(16), 352);
      assert.equal(header.readUInt32BE(20), 352);
      assert.equal(header[25], 6, 'RGBA color type');
      heights.push(declared.visibleBounds.height);
    }
    for (const height of heights) {
      assert.ok(Math.abs(height - heights[0]) <= 2, `visible height within ±2px (${height} vs ${heights[0]})`);
    }
  }
  assert.equal(animations.defaultFrameDurationMs, 1000, 'the pack-wide default stays 1000ms for other states');
});

// ---------------------------------------------------------------------------
// Task E5a-R1 — play order and foot-line locks.
//
// Diagnosis (real-shell probe, /tmp/e5a-r1-evidence/): the render path itself
// is animations-array-driven (asset-pack builds frames from animations.json,
// the module's frameIndex indexes that array, the renderer resolves the file
// per index) — no production path sorts by filename or enumerates anchors
// keys for playback. Two REAL hazards existed though: the anchors.json frames
// map used to carry the passing entries LAST (lexicographic key order), so
// any key-order enumeration would play passing at the end; and a frameIndex
// producer built from a DIFFERENT pack (e.g. a stale 4-frame installed pack)
// shifts passing into 03's slot and drops 04 entirely (probe-reproduced as
// [01, 02, passing, 03]). The locks below pin everything to the metadata.
// ---------------------------------------------------------------------------

test('E5a-R1: anchors.json frames keys follow the animations.json metadata order', () => {
  const animations = JSON.parse(fs.readFileSync(path.join(BUILTIN_PACK, 'animation', 'animations.json'), 'utf8'));
  const anchors = JSON.parse(fs.readFileSync(path.join(BUILTIN_PACK, 'animation', 'anchors.json'), 'utf8'));
  for (const direction of ['left', 'right']) {
    const declared = animations.animations[`walk-${direction}`].frames.map((frame) => frame.file);
    // 重复帧合法：anchors map 键唯一，不变式按“活跃帧唯一键的元数据序”表达
    const declaredUnique = [...new Set(declared)];
    const anchorKeys = Object.keys(anchors.frames).filter((file) => declaredUnique.includes(file));
    assert.deepEqual(anchorKeys, declaredUnique, `walk-${direction} anchors active keys must follow the unique metadata order`);
  }
});

test('E5a-R1: the pack API serves the frame sequence strictly in metadata order', () => {
  const animations = JSON.parse(fs.readFileSync(path.join(BUILTIN_PACK, 'animation', 'animations.json'), 'utf8'));
  const pack = builtinPack();
  for (const direction of ['left', 'right', 'up', 'down']) {
    const declared = animations.animations[`walk-${direction}`].frames.map((frame) => frame.file);
    const served = pack.animation(`walk-${direction}`).frames.map((frame) => frame.file);
    assert.deepEqual(served, declared, `walk-${direction} play order === animations.json order`);
    // index-based geometry resolves the SAME sequence (the renderer's path)
    for (let index = 0; index < declared.length; index += 1) {
      assert.equal(pack.frameGeometry(`walk-${direction}`, index).file, declared[index]);
    }
    // 首尾帧就是 b01..bNN 的两端（二代序列不重复、不跳号）
    assert.match(pack.frameGeometry(`walk-${direction}`, 0).file, /-b01\.png$/);
    assert.match(pack.frameGeometry(`walk-${direction}`, declared.length - 1).file, new RegExp(`-b${String(declared.length).padStart(2, '0')}\\.png$`));
  }
});

test('E5a-R1 guard: a declared play order that differs from the filename order still plays as declared', () => {
  // 二代命名 b01..bNN 让"文件名字典序 == 元数据序"，真实包不再能区分
  // "按文件名排序播放"这一隐患（旧素材靠 c02/passing 的命名陷阱区分）。
  // 这里用一份**故意打乱声明顺序**的合成包做负例：播放序必须来自
  // animations.json 的数组序，而不是文件名排序。
  const animations = JSON.parse(fs.readFileSync(path.join(BUILTIN_PACK, 'animation', 'animations.json'), 'utf8'));
  const anchors = JSON.parse(fs.readFileSync(path.join(BUILTIN_PACK, 'animation', 'anchors.json'), 'utf8'));
  const entry = animations.animations['walk-left'];
  const declared = entry.frames.map((frame) => frame.file);
  // 前四帧换序（b04, b02, b03, b01 …），其余保持 → 声明序 ≠ 字典序
  const shuffled = [declared[3], declared[1], declared[2], declared[0], ...declared.slice(4)];
  assert.notDeepEqual(shuffled, [...shuffled].sort(), 'the fixture is really out of filename order');
  const mutated = {
    ...animations,
    animations: {
      ...animations.animations,
      'walk-left': { ...entry, frames: entry.frames.map((frame, index) => ({ ...frame, file: shuffled[index] })) },
    },
  };
  const pack = assetPack.createAssetPack({
    manifest: JSON.parse(fs.readFileSync(path.join(BUILTIN_PACK, 'manifest.json'), 'utf8')),
    anchors,
    animations: mutated,
  }).pack;
  assert.deepEqual(pack.animation('walk-left').frames.map((frame) => frame.file), shuffled,
    'play order comes from the declared array, never from filename sorting');
  for (let index = 0; index < shuffled.length; index += 1) {
    assert.equal(pack.frameGeometry('walk-left', index).file, shuffled[index],
      `frameGeometry(${index}) follows the declared order`);
  }
});

test('E5a-R1: every walk frame shares the pack sole line (no vertical hop)', () => {
  // 鞋线 = 最低 alpha>=128 行（管线的主体阈值）。二代素材逐帧归一化后，
  // 同一方向内所有帧的鞋线必须落在 ±1px 内——否则播放会出现"上下跳"。
  const script = `
import glob, json, os
from PIL import Image
import numpy as np
pack = 'resources/characters/deepseek-default/assets/animations/walk'
out = {}
for direction in ['left', 'right', 'up', 'down']:
    names = sorted(os.path.basename(p) for p in glob.glob(f'{pack}/{direction}/walk-{direction}-b*.png'))
    rows = {}
    for name in names:
        a = np.array(Image.open(f'{pack}/{direction}/{name}').convert('RGBA'))[:, :, 3]
        rows[name] = int(np.where((a >= 128).any(axis=1))[0].max())
    values = list(rows.values())
    out[direction] = {'files': len(values), 'min': min(values), 'max': max(values), 'range': max(values) - min(values)}
print(json.dumps(out))
`;
  const measured = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
  const expectedCounts = { left: 15, right: 15, up: 14, down: 15 };
  for (const direction of ['left', 'right', 'up', 'down']) {
    assert.equal(measured[direction].files, expectedCounts[direction], `${direction}: all frames measured`);
    assert.equal(measured[direction].range <= 1, true,
      `${direction}: sole line within ±1px across the sequence (got ${JSON.stringify(measured[direction])})`);
  }
});

test('E5a-R1: no code path sorts walk frame filenames for playback order', () => {
  // grep-lock: a lexicographic sort of frame filenames used as a play sequence
  // would silently move the passing frame after 04. The play order must come
  // from animations.json array order only. If a sort is ever needed for a
  // non-playback purpose, restructure the line so this scan stays clean.
  // P5 (2026-09-23): test/fixtures (the acceptance-harness probe templates)
  // left the product repo with the authoring block — the scan root that no
  // longer exists was removed; the production page under src/office stays
  // fully covered.
  const scanRoots = [
    path.join(ROOT, 'src', 'office'),
  ];
  const offenders = [];
  const walkFramePattern = /walk-(?:left|right|up|down)[^'"]*\.(?:png|json)/;
  const sortPattern = /\.sort\s*\(/;
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(abs); continue; }
      if (!/\.(js|html)$/.test(entry.name)) continue;
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (walkFramePattern.test(line) && sortPattern.test(line)) {
          offenders.push(`${path.relative(ROOT, abs)}:${index + 1}`);
        }
      });
    }
  };
  for (const root of scanRoots) scan(root);
  assert.deepEqual(offenders, [], `frame filenames must never be sorted for playback: ${offenders.join(', ')}`);
});
