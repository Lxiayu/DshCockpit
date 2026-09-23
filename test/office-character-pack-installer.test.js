'use strict';

// Task 2 / SPEC-02 — character pack installer tests.
// RED: src/office/runtime/character-pack-installer.js does not exist yet.
//
// Covers: discovered -> validated -> installed -> active lifecycle, safe ZIP
// extraction (traversal, absolute paths, symlinks, executables, duplicate
// entries, file count / per-file / total size limits, compression-ratio bombs,
// manifest-external files), same-filesystem atomic rename, failed updates
// retaining the previous active pack, and the fallback order resolver.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');

let installerModule;
try {
  installerModule = require(path.join(ROOT, 'src', 'office', 'runtime', 'character-pack-installer.js'));
} catch (error) {
  installerModule = null;
}

const { createCharacterPackInstaller } = installerModule || {};
const validator = (() => {
  try {
    return require(path.join(ROOT, 'src', 'office', 'runtime', 'validate-character-pack.js'));
  } catch (error) {
    return null;
  }
})();

// ---------------------------------------------------------------------------
// deterministic minimal PNG + ZIP writers (node builtins only)
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

function makeSpritePng({ color = [40, 90, 200, 255] } = {}) {
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc(height * (1 + width * 4));
  let off = 0;
  for (let y = 0; y < height; y += 1) {
    raw[off] = 0;
    off += 1;
    for (let x = 0; x < width; x += 1) {
      const inBody = y >= 20 && y <= 60 && Math.abs(x - 32) <= 10;
      raw[off] = inBody ? color[0] : 0;
      raw[off + 1] = inBody ? color[1] : 0;
      raw[off + 2] = inBody ? color[2] : 0;
      raw[off + 3] = inBody ? color[3] : 0;
      off += 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function dosTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

// Builds a real ZIP archive (stored or deflate entries). `entries` maps
// name -> Buffer; `opts.entries` adds or overrides entries with per-entry
// { data, method, mode } — e.g. to inject malicious entries.
function buildZip(entries, opts = {}) {
  const merged = {};
  const overrides = new Map();
  for (const [name, data] of Object.entries(entries)) merged[name] = data;
  for (const [name, override] of Object.entries(opts.entries || {})) {
    if (override.data !== undefined) merged[name] = override.data;
    overrides.set(name, override);
  }
  const localParts = [];
  const centralParts = [];
  const fixedDate = opts.date || new Date(2026, 7, 30, 12, 0, 0);
  const { time, day } = dosTime(fixedDate);
  const ordered = Object.keys(merged).map((name) => ({ name, data: merged[name], override: overrides.get(name) || {} }));
  for (const extra of opts.extraEntries || []) {
    ordered.push({ name: extra.name, data: extra.data, override: extra });
  }
  for (const { name, data, override } of ordered) {
    const method = override.method === undefined ? 8 : override.method; // deflate
    const mode = override.mode === undefined ? 0o100644 : override.mode;
    const nameBytes = Buffer.from(name, 'utf8');
    let payload = data;
    if (method === 8) payload = zlib.deflateRawSync(data);
    const localHeaderOffset = localParts.reduce((acc, p) => acc + p.length, 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc32Of(data), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc32Of(data), 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((mode << 16) >>> 0, 38); // external attrs (unix mode)
    central.writeUInt32LE(localHeaderOffset, 42);
    centralParts.push(central, nameBytes);
  }
  const localSize = localParts.reduce((acc, p) => acc + p.length, 0);
  const centralSize = centralParts.reduce((acc, p) => acc + p.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(ordered.length, 8);
  eocd.writeUInt16LE(ordered.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localSize, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

// ---------------------------------------------------------------------------
// shared good-pack fixture builder (mirrors the pack contract)
// ---------------------------------------------------------------------------

function baseManifest(id, version) {
  return {
    schemaVersion: 1,
    id,
    version,
    author: 'DshCockpit test',
    license: 'MIT (test fixture)',
    runtimeCompatibility: { schema: 1 },
    geometry: 'animation/anchors.json',
    animations: 'animation/animations.json',
    fallback: { allowStaticPose: true, allowProgrammaticEmphasis: true },
  };
}

function goodPackFiles(id, version) {
  const frame = { file: 'assets/expressions/idle.png', durationMs: null, anchor: null, visibleBounds: { x: 22, y: 20, width: 20, height: 40 } };
  return {
    'manifest.json': JSON.stringify(baseManifest(id, version)),
    'animation/anchors.json': JSON.stringify({
      schemaVersion: 1,
      sourceCanvas: { width: 64, height: 64 },
      outputCanvas: { width: 64, height: 64 },
      outputScale: 1,
      anchor: { x: 32, y: 60 },
      visibleBounds: { x: 22, y: 20, width: 20, height: 40 },
      frames: {},
    }),
    'animation/animations.json': JSON.stringify({
      schemaVersion: 1,
      defaultFrameDurationMs: 1000,
      animations: {
        idle: { state: 'idle', direction: 'none', loop: true, frames: [frame] },
        'walk-left': { state: 'walk', direction: 'left', loop: true, frames: [frame] },
        'walk-right': { state: 'walk', direction: 'right', loop: true, frames: [frame] },
        'walk-up': { state: 'walk', direction: 'up', loop: true, frames: [frame] },
        'walk-down': { state: 'walk', direction: 'down', loop: true, frames: [frame] },
      },
    }),
    'assets/expressions/idle.png': makeSpritePng(),
    LICENSE: 'MIT (test fixture)\n',
    NOTICE: 'test fixture\n',
  };
}

function writePack(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function newInstaller() {
  const packsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'office-packs-'));
  const installer = createCharacterPackInstaller({
    packsRoot,
    builtinPackPath: path.join(ROOT, 'resources', 'characters', 'deepseek-default'),
  });
  return { installer, packsRoot };
}

function expectsError(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return;
  }
  assert.fail(`expected error ${code}, but nothing was thrown`);
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

test('installer module exists and never imports electron or the network', () => {
  assert.ok(createCharacterPackInstaller, 'src/office/runtime/character-pack-installer.js must exist');
  const src = fs.readFileSync(path.join(ROOT, 'src', 'office', 'runtime', 'character-pack-installer.js'), 'utf8');
  assert.doesNotMatch(src, /require\(\s*['"]electron['"]/);
  assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|http\.request/);
  assert.match(src, /['"]use strict['"]/);
});

test('folder import walks discovered -> validated -> installed -> active', () => {
  const { installer } = newInstaller();
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-src-'));
  writePack(sourceDir, goodPackFiles('folder-pack', '1.0.0'));

  const discovered = installer.importFromFolder(sourceDir);
  assert.equal(discovered.state, 'discovered');

  const validated = installer.validateImport(discovered.importId);
  assert.equal(validated.state, 'validated');
  assert.equal(validated.packId, 'folder-pack');
  assert.equal(validated.version, '1.0.0');

  const installed = installer.installImport(discovered.importId);
  assert.equal(installed.state, 'installed');
  assert.ok(fs.existsSync(path.join(installed.installPath, 'manifest.json')));

  const active = installer.activate('folder-pack', '1.0.0');
  assert.equal(active.state, 'active');
  assert.equal(installer.getActive().version, '1.0.0');
  assert.equal(installer.getActive().packId, 'folder-pack');
});

test('zip import activates a well-formed archive', () => {
  const { installer } = newInstaller();
  const zip = buildZip(goodPackFiles('zip-pack', '2.0.0'));
  const discovered = installer.importFromZip(zip);
  assert.equal(discovered.state, 'discovered');
  installer.validateImport(discovered.importId);
  const installed = installer.installImport(discovered.importId);
  assert.equal(installed.packId, 'zip-pack');
  installer.activate('zip-pack', '2.0.0');
  assert.equal(installer.getActive().packId, 'zip-pack');
});

test('zip rejects path traversal, absolute paths and backslash names', () => {
  const { installer } = newInstaller();
  for (const name of ['../evil.txt', 'a/../../evil.txt', '/abs/evil.txt', 'win\\path.txt', 'C:\\evil.txt']) {
    const zip = buildZip(goodPackFiles('evil-pack', '1.0.0'), { entries: { [name]: { data: Buffer.from('x'), method: 0 } } });
    expectsError(() => installer.importFromZip(zip), 'PACK_UNSAFE_ARCHIVE');
  }
});

test('zip rejects symlink and executable entries', () => {
  const { installer } = newInstaller();
  const symlinkZip = buildZip(goodPackFiles('link-pack', '1.0.0'), {
    entries: { 'assets/link.png': { data: Buffer.from('../target'), method: 0, mode: 0o120777 } },
  });
  expectsError(() => installer.importFromZip(symlinkZip), 'PACK_UNSAFE_ARCHIVE');

  const exeZip = buildZip(goodPackFiles('exe-pack', '1.0.0'), {
    entries: { 'assets/animations/run.sh': { data: Buffer.from('#!/bin/sh\n'), method: 0, mode: 0o100755 } },
  });
  expectsError(() => installer.importFromZip(exeZip), 'PACK_UNSAFE_ARCHIVE');
});

test('zip rejects duplicate entry names', () => {
  const { installer } = newInstaller();
  const files = goodPackFiles('dup-pack', '1.0.0');
  const zip = buildZip(files, {
    extraEntries: [{ name: 'manifest.json', data: Buffer.from(files['manifest.json']), method: 0 }],
  });
  expectsError(() => installer.importFromZip(zip), 'PACK_UNSAFE_ARCHIVE');
});

test('zip enforces entry count, per-file size, total size and compression ratio limits', () => {
  const { installer } = newInstaller();
  // entry count: build a zip with many tiny junk entries
  const many = goodPackFiles('count-pack', '1.0.0');
  for (let i = 0; i < 600; i += 1) many[`assets/junk-${i}.txt`] = Buffer.from('x');
  // .txt is not an allowed extension anyway, but the count check fires first
  expectsError(() => installer.importFromZip(buildZip(many)), 'PACK_UNSAFE_ARCHIVE');

  // per-file size: declare an oversized file
  const big = goodPackFiles('big-pack', '1.0.0');
  const bigZip = buildZip(big, {
    entries: { 'assets/expressions/huge.png': { data: Buffer.alloc(64 * 1024 * 1024 + 1, 0), method: 0 } },
  });
  // building a 64MB buffer is fine; the installer must reject before inflating
  expectsError(() => installer.importFromZip(bigZip), 'PACK_ASSET_TOO_LARGE');

  // total size: many medium entries beyond the total cap
  const total = goodPackFiles('total-pack', '1.0.0');
  for (let i = 0; i < 40; i += 1) total[`assets/bulk-${i}.png`] = Buffer.alloc(2 * 1024 * 1024, 7);
  expectsError(() => installer.importFromZip(buildZip(total)), 'PACK_ASSET_TOO_LARGE');

  // compression ratio bomb: tiny deflate stream claiming a huge output
  const bomb = goodPackFiles('bomb-pack', '1.0.0');
  const bombZip = buildZip(bomb, {
    entries: { 'assets/expressions/bomb.png': { data: Buffer.alloc(0), method: 0 } },
  });
  // craft a bomb by declaring a huge uncompressed size in the central directory
  const fake = buildZip(goodPackFiles('bomb-pack', '1.0.0'));
  // patch the first entry (manifest.json) sizes to a huge value with ratio > 200
  const patched = patchFirstEntrySizes(fake, 4 * 1024 * 1024 + 1);
  expectsError(() => installer.importFromZip(patched), 'PACK_ASSET_TOO_LARGE');
  assert.ok(bombZip.length > 0); // the unused local helper stays referenced
});

function patchFirstEntrySizes(zipBuffer, declaredUncompressed) {
  // locate the first central directory header and inflate its declared size
  const buf = Buffer.from(zipBuffer);
  let off = buf.length - 22;
  while (off >= 0 && buf.readUInt32LE(off) !== 0x06054b50) off -= 1;
  const cdOffset = buf.readUInt32LE(off + 16);
  let p = cdOffset;
  assert.equal(buf.readUInt32LE(p), 0x02014b50);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const localOff = buf.readUInt32LE(p + 42);
  buf.writeUInt32LE(declaredUncompressed, p + 24); // uncompressed size (central)
  buf.writeUInt32LE(4 * 1024 * 1024, p + 20); // compressed size passes per-file cap? no: per-file cap is 4MB; compressed smaller is fine
  // also patch the local header uncompressed size
  buf.writeUInt32LE(declaredUncompressed, localOff + 22);
  void nameLen; void extraLen; void commentLen;
  return buf;
}

test('zip rejects manifest-external files', () => {
  const { installer } = newInstaller();
  const files = goodPackFiles('stray-pack', '1.0.0');
  files['assets/expressions/stray.png'] = makeSpritePng({ color: [1, 2, 3, 255] });
  const zip = buildZip(files);
  const discovered = installer.importFromZip(zip);
  expectsError(() => installer.validateImport(discovered.importId), 'PACK_UNSAFE_ARCHIVE');
});

test('folder import rejects executable content and manifest-external files', () => {
  const { installer } = newInstaller();
  // SPEC-02: executable extensions are refused at import time
  const evilDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-evil-'));
  const files = goodPackFiles('evil-folder', '1.0.0');
  files['assets/animations/left.js'] = 'module.exports = null;\n';
  writePack(evilDir, files);
  expectsError(() => installer.importFromFolder(evilDir), 'PACK_UNSAFE_ARCHIVE');

  // manifest-external assets are refused at validation time
  const strayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-stray-'));
  const strayFiles = goodPackFiles('stray-folder', '1.0.0');
  strayFiles['assets/expressions/stray.png'] = makeSpritePng({ color: [9, 9, 9, 255] });
  writePack(strayDir, strayFiles);
  const discovered = installer.importFromFolder(strayDir);
  expectsError(() => installer.validateImport(discovered.importId), 'PACK_UNSAFE_ARCHIVE');
});

test('failed update retains the previous active pack and cleans the temp dir', () => {
  const { installer, packsRoot } = newInstaller();
  // install + activate v1
  const v1Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-v1-'));
  writePack(v1Dir, goodPackFiles('retained-pack', '1.0.0'));
  const d1 = installer.importFromFolder(v1Dir);
  installer.validateImport(d1.importId);
  installer.installImport(d1.importId);
  installer.activate('retained-pack', '1.0.0');
  const activePathBefore = installer.getActive().installPath;

  // v2 is invalid (missing required walk state)
  const v2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-v2-'));
  const v2Files = goodPackFiles('retained-pack', '2.0.0');
  const v2Anchors = JSON.parse(v2Files['animation/animations.json']);
  delete v2Anchors.animations['walk-left'];
  delete v2Anchors.animations['walk-right'];
  delete v2Anchors.animations['walk-up'];
  delete v2Anchors.animations['walk-down'];
  v2Files['animation/animations.json'] = JSON.stringify(v2Anchors);
  delete v2Files['assets/expressions/idle.png'];
  writePack(v2Dir, v2Files);
  const d2 = installer.importFromFolder(v2Dir);
  expectsError(() => installer.validateImport(d2.importId), 'PACK_ASSET_MISSING');

  // previous active pack is untouched and no v2 directory exists
  assert.equal(installer.getActive().version, '1.0.0');
  assert.equal(installer.getActive().installPath, activePathBefore);
  assert.ok(fs.existsSync(path.join(activePathBefore, 'manifest.json')));
  const versionRoot = path.join(packsRoot, 'retained-pack', 'versions');
  assert.deepEqual(fs.readdirSync(versionRoot), ['1.0.0']);
  const incoming = path.join(packsRoot, 'incoming');
  assert.deepEqual(fs.readdirSync(incoming), [], 'failed import temp dir must be cleaned');
});

test('installation is a same-filesystem atomic rename into packsRoot', () => {
  const { installer, packsRoot } = newInstaller();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'office-atomic-'));
  writePack(src, goodPackFiles('atomic-pack', '1.0.0'));
  const d = installer.importFromFolder(src);
  installer.validateImport(d.importId);
  const installed = installer.installImport(d.importId);
  const expected = path.join(packsRoot, 'atomic-pack', 'versions', '1.0.0');
  assert.equal(path.resolve(installed.installPath), path.resolve(expected));
  assert.ok(fs.existsSync(expected));
  // the import temp area no longer holds this import
  assert.ok(!fs.existsSync(path.join(packsRoot, 'incoming', d.importId)));
});

test('same-version reinstall is rejected with a stable code', () => {
  const { installer } = newInstaller();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'office-dup-'));
  writePack(src, goodPackFiles('dup-pack', '1.0.0'));
  const d1 = installer.importFromFolder(src);
  installer.validateImport(d1.importId);
  installer.installImport(d1.importId);
  const src2 = fs.mkdtempSync(path.join(os.tmpdir(), 'office-dup2-'));
  writePack(src2, goodPackFiles('dup-pack', '1.0.0'));
  const d2 = installer.importFromFolder(src2);
  installer.validateImport(d2.importId);
  expectsError(() => installer.installImport(d2.importId), 'PACK_VERSION_EXISTS');
});

test('fallback order: invalid selected pack -> built-in deepseek-default -> diagnostic placeholder', () => {
  const { installer, packsRoot } = newInstaller();
  // builtin pack must validate
  const builtin = installer.resolveRenderablePack(null);
  assert.equal(builtin.kind, 'builtin');
  assert.match(builtin.installPath, /deepseek-default$/);

  // an invalid selected pack falls back to the builtin
  const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-broken-'));
  fs.writeFileSync(path.join(brokenDir, 'manifest.json'), '{ "schemaVersion": 1 }');
  const broken = installer.resolveRenderablePack(brokenDir);
  assert.equal(broken.kind, 'builtin');

  // if the builtin were missing too, the resolver returns a stable placeholder
  const bare = createCharacterPackInstaller({
    packsRoot,
    builtinPackPath: path.join(packsRoot, 'does-not-exist'),
  });
  const placeholder = bare.resolveRenderablePack(null);
  assert.equal(placeholder.kind, 'placeholder');
  assert.equal(placeholder.code, 'PACK_LOAD_FAILED');
});

test('no character-pack JavaScript is ever executed: importer refuses JS content before activation', () => {
  const { installer } = newInstaller();
  const zip = buildZip(goodPackFiles('js-pack', '1.0.0'), {
    entries: { 'assets/expressions/behavior.js': { data: Buffer.from('process.exit(1)'), method: 0, mode: 0o100644 } },
  });
  // import-time refusal: the JS entry never reaches disk, let alone execution
  expectsError(() => installer.importFromZip(zip), 'PACK_UNSAFE_ARCHIVE');
});

test('folder import rejects hardlinked regular files (nlink > 1)', () => {
  const { installer } = newInstaller();
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-hardlink-'));
  const files = goodPackFiles('hardlink-pack', '1.0.0');
  writePack(sourceDir, files);
  // two directory entries pointing at the same inode inside the pack
  fs.linkSync(
    path.join(sourceDir, 'assets/expressions/idle.png'),
    path.join(sourceDir, 'assets/expressions/idle-alias.png')
  );
  assert.equal(fs.statSync(path.join(sourceDir, 'assets/expressions/idle.png')).nlink, 2);
  expectsError(() => installer.importFromFolder(sourceDir), 'PACK_UNSAFE_ARCHIVE');
});

test('malicious activate() cannot escape packsRoot', () => {
  const { installer, packsRoot } = newInstaller();
  expectsError(() => installer.activate('../outside', '1.0.0'), 'PACK_MANIFEST_INVALID');
  expectsError(() => installer.activate('pack', '../outside'), 'PACK_MANIFEST_INVALID');
  expectsError(() => installer.activate('/abs/pack', '1.0.0'), 'PACK_MANIFEST_INVALID');
  expectsError(() => installer.activate('pack', '1.0.0\\..\\evil'), 'PACK_MANIFEST_INVALID');
  // nothing was created outside packsRoot
  const parentEntries = fs.readdirSync(path.dirname(packsRoot));
  assert.ok(!parentEntries.includes('outside'), 'no directory escaped packsRoot');
});

test('active.json stays portable: no machine-specific absolute paths', () => {
  const { installer, packsRoot } = newInstaller();
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-portable-'));
  writePack(sourceDir, goodPackFiles('portable-pack', '1.0.0'));
  const d = installer.importFromFolder(sourceDir);
  installer.validateImport(d.importId);
  installer.installImport(d.importId);
  installer.activate('portable-pack', '1.0.0');
  const raw = fs.readFileSync(path.join(packsRoot, 'active.json'), 'utf8');
  const pointer = JSON.parse(raw);
  assert.deepEqual(Object.keys(pointer).sort(), ['packId', 'version']);
  assert.ok(!raw.includes(packsRoot), 'pointer must not embed the packsRoot absolute path');
  assert.ok(!raw.includes('/'), 'pointer values must contain no path separators');
  // the public shape still exposes a derived installPath
  const active = installer.getActive();
  assert.equal(active.packId, 'portable-pack');
  assert.equal(active.version, '1.0.0');
  assert.equal(active.installPath, path.join(packsRoot, 'portable-pack', 'versions', '1.0.0'));
  assert.ok(fs.existsSync(path.join(active.installPath, 'manifest.json')));
});

test('validator is available to the installer as a module (single source of truth)', () => {
  assert.ok(validator && typeof validator.validateCharacterPack === 'function');
});
