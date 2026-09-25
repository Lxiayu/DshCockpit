// scripts/verify-dist.js — post-build artifact verification.
//
// The release artifact is a portable zip; the most common user-facing failure
// is a truncated/broken extraction ("cannot find dsh runtime (lib/bin.js)").
// This verifies that the produced zip actually contains everything the app
// needs at first boot, before anything is published:
//   - DshCockpit.exe at the zip root
//   - resources/app.asar
//   - resources/app-update.yml (electron-updater feed)
//   - resources/runtime/<v>/node_modules/@deepseek-ai/dsh/lib/bin.js (non-empty)
// It also reports the deepest entry path (Windows path-length guard) and the
// artifact size. No new dependencies: the zip central directory is parsed with
// a tiny reader (names + uncompressed sizes only; nothing is extracted).
//
// 2026-09-23 P5 排包闸门：app.asar 内部也纳入校验（header 直读，无新依赖）——
//   negative: the authoring block (editor core / workbench shell+lib / playground /
//             character-pack fixtures / gen-* scripts / content tree) must NOT
//             ship inside the artifact (electron-builder.js `files` exclusions);
//   positive: the production office surface AND the runtime materials
//             (resources/office/layout-editor/** furniture, resources/characters/**)
//             MUST ship — the exclusion list must never eat production assets.
// Existing positive assertions are never relaxed by this; the asar checks are
// additive gates (win zip/win-unpacked + mac .app/zip all run them).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DIST = path.join(__dirname, '..', 'dist');
const RUNTIME_RE = /^resources\/runtime\/[^\\/]+\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js$/;

// ---------------------------------------------------------------------------
// P5 authoring-block gates (asar entry paths, POSIX separators)
// ---------------------------------------------------------------------------

// Must NOT appear inside app.asar. Prefixes match whole path segments; exact
// paths match the full entry name.
const FORBIDDEN_ASAR_PREFIXES = [
  'src/workbench/',
  'src/office/fixtures/character-pack/',
];
const FORBIDDEN_ASAR_PATHS = [
  'src/office/layout-editor.js',
  'src/office/playground.html',
  'src/office/playground-page.js',
  'src/office/playground.css',
  'src/office/fixtures/events.json',
  'src/office/fixtures/waypoints.json',
];
// Catch-all regexes for the authoring surface (defence in depth: a future
// `files` widening must fail the build here, not silently re-bloat the asar).
const FORBIDDEN_ASAR_PATTERNS = [
  /(^|\/)gen-[a-z0-9-]+\.js$/,
  /^content\//,
  /^photo\//,
  /^artifacts\//,
  /^test\//,
  /^docs\//,
];

// MUST appear inside app.asar (the production office surface).
const REQUIRED_ASAR_PATHS = [
  'src/main.js',
  'src/preload.js',
  'src/office/office.html',
  'src/office/office.css',
  'src/office/office-boot.js',
  'src/office/office-page.js',
  'src/office/office-preload.js',
  'src/office/office-protocol.js',
  'src/office/office-pack-resolver.js',
  'src/office/layout-assets.js',
  'src/office/layout-schema.js',
  'src/office/fixtures/office-layout.json',
  'src/office/fixtures/office-layout-draft.json',
  'src/office/fixtures/office-layout-flat.json',
  'src/office/render/pixi-office-renderer.js',
  'src/office/runtime/character-pack-installer.js',
  // P5: the installer requires this validator at module level — it MUST ship
  // inside the asar (script trees under scripts/ are not packaged).
  'src/office/runtime/validate-character-pack.js',
  'node_modules/pixi.js/dist/pixi.min.js',
];

// asar entry-count budget: measured 3,275 on the first P5 build (baseline was
// 3,327 with the authoring block; 52 authoring entries excluded) + 10% headroom
// so future legitimate additions do not trip the gate, while a wholesale
// authoring-block regression (hundreds of entries) still fails loudly.
const ASAR_ENTRY_BUDGET = 3603;

// extraResources materials the office view needs at runtime (name prefixes in
// the artifact; the layout-editor/ directory is the production furniture
// source — same name as the excluded editor MODULE, different thing).
const REQUIRED_RESOURCE_PATTERNS = [
  /^resources\/office\/layout-editor\/[^/]+\.png$/,
  /^resources\/office\/flat\/[^/]+\.png$/,
  /^resources\/characters\/deepseek-default\/manifest\.json$/,
  /^resources\/dialogue\/.+\.json$/,
];

/** Read zip central-directory entries: { name, method, compSize, uncompSize, offset }. */
function listZipEntries(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  const size = fs.statSync(zipPath).size;
  const CHUNK = 65536;
  const tailStart = Math.max(0, size - CHUNK);
  const tail = Buffer.alloc(size - tailStart);
  fs.readSync(fd, tail, 0, tail.length, tailStart);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = tailStart + i; break; }
  }
  if (eocd === -1) { fs.closeSync(fd); throw new Error('EOCD not found — not a zip'); }
  const count = tail.readUInt16LE(eocd - tailStart + 10);
  const cdSize = tail.readUInt32LE(eocd - tailStart + 12);
  const cdOffset = tail.readUInt32LE(eocd - tailStart + 16);
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  fs.closeSync(fd);
  const entries = [];
  let off = 0;
  for (let i = 0; i < count; i++) {
    if (off + 46 > cd.length || cd.readUInt32LE(off) !== 0x02014b50) break;
    const method = cd.readUInt16LE(off + 10);
    const compSize = cd.readUInt32LE(off + 20);
    const uncompSize = cd.readUInt32LE(off + 24);
    const nameLen = cd.readUInt16LE(off + 28);
    const extraLen = cd.readUInt16LE(off + 30);
    const commentLen = cd.readUInt16LE(off + 32);
    const offset = cd.readUInt32LE(off + 42);
    const name = cd.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, uncompSize, offset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extract one stored/deflated file from a zip into a Buffer (no temp files). */
function extractZipEntry(zipPath, entry) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const lh = Buffer.alloc(30);
    fs.readSync(fd, lh, 0, 30, entry.offset);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header for ' + entry.name);
    const nameLen = lh.readUInt16LE(26);
    const extraLen = lh.readUInt16LE(28);
    const data = Buffer.alloc(entry.compSize);
    fs.readSync(fd, data, 0, entry.compSize, entry.offset + 30 + nameLen + extraLen);
    if (entry.method === 0) return data;
    if (entry.method === 8) return zlib.inflateRawSync(data);
    throw new Error('unsupported zip method ' + entry.method + ' for ' + entry.name);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parse an app.asar header (from a Buffer or a path) and list every entry
 * path. Format mirrors @electron/asar disk.js: [uint32 outer pickle header
 * size = 4][uint32 header size][uint32 payload length][JSON header].
 */
function listAsarEntries(asarOrPath) {
  const fd = typeof asarOrPath === 'string' ? fs.openSync(asarOrPath, 'r') : null;
  try {
    let prefix;
    if (fd) {
      prefix = Buffer.alloc(8);
      if (fs.readSync(fd, prefix, 0, 8, 0) !== 8) throw new Error('unable to read asar header size');
    } else {
      prefix = asarOrPath.subarray(0, 8);
    }
    const size = prefix.readUInt32LE(4);
    let hb;
    if (fd) {
      hb = Buffer.alloc(size);
      if (fs.readSync(fd, hb, 0, size, 8) !== size) throw new Error('unable to read asar header');
    } else {
      hb = asarOrPath.subarray(8, 8 + size);
    }
    const strLen = hb.readUInt32LE(4);
    const header = JSON.parse(hb.toString('utf8', 8, 8 + strLen));
    const out = [];
    const walk = (filesMap, rel) => {
      for (const [name, child] of Object.entries(filesMap)) {
        const childRel = rel ? rel + '/' + name : name;
        if (child.files) walk(child.files, childRel);
        else out.push(childRel);
      }
    };
    walk(header.files || {}, '');
    return out.sort();
  } finally {
    if (fd) fs.closeSync(fd);
  }
}

function check(ok, label) {
  if (ok) console.log('  [ok]  ' + label);
  else { console.log('  [FAIL] ' + label); }
  return ok;
}

/** P5 asar gates: authoring block absent, production surface + materials present. */
function verifyAsarEntries(entries, describe) {
  let ok = true;
  const names = new Set(entries);
  console.log('  [info] asar (' + describe + '): ' + entries.length + ' entries');

  const forbiddenHits = [];
  for (const e of entries) {
    if (FORBIDDEN_ASAR_PREFIXES.some((p) => e.startsWith(p))) forbiddenHits.push(e);
    else if (FORBIDDEN_ASAR_PATHS.includes(e)) forbiddenHits.push(e);
    else if (FORBIDDEN_ASAR_PATTERNS.some((re) => re.test(e))) forbiddenHits.push(e);
  }
  ok = check(forbiddenHits.length === 0,
    'authoring block absent from asar (editor/workbench/playground/character-pack fixtures/gen-*/content/photo/artifacts)'
    + (forbiddenHits.length ? ' — offenders: ' + forbiddenHits.slice(0, 5).join(', ') + (forbiddenHits.length > 5 ? ` (+${forbiddenHits.length - 5} more)` : '') : ''))
    && ok;

  const missing = REQUIRED_ASAR_PATHS.filter((p) => !names.has(p));
  ok = check(missing.length === 0, 'production office surface present in asar'
    + (missing.length ? ' — missing: ' + missing.join(', ') : '')) && ok;

  ok = check(entries.length <= ASAR_ENTRY_BUDGET,
    `asar entry count ${entries.length} <= budget ${ASAR_ENTRY_BUDGET}`) && ok;
  return ok;
}

/** Verify a directory tree (win-unpacked / mac .app) or a zip. Returns true when ok. */
function verifyTree(getEntries, describe, opts) {
  let ok = true;
  opts = opts || {};
  const entries = getEntries();
  const names = new Set(entries.map((e) => e.name.replace(/\\/g, '/')));
  if (opts.exeName) {
    ok = check(names.has(opts.exeName), opts.exeName + ' at root') && ok;
  } else {
    console.log('  [info] ' + describe + ': mac artifact — no exe assertion by design');
  }
  ok = check(names.has(opts.asarPath), opts.asarPath) && ok;
  // electron-builder only writes the updater feed for --publish always builds
  if (opts.requireUpdaterFeed) {
    ok = check(names.has(opts.updaterFeed), opts.updaterFeed + ' (updater feed)') && ok;
  } else {
    console.log('  [info] ' + opts.updaterFeed + ' skipped (--publish never build)');
  }
  if (opts.slim) {
    console.log('  [info] slim artifact: bundled-runtime checks skipped by design');
  } else {
    const runtimeBins = entries.filter((e) => RUNTIME_RE.test(e.name.replace(/\\/g, '/')));
    ok = check(runtimeBins.length > 0, 'bundled runtime lib/bin.js present (' + runtimeBins.length + ')') && ok;
    const emptyBins = runtimeBins.filter((e) => (e.uncompSize === undefined ? 0 : e.uncompSize) === 0);
    ok = check(emptyBins.length === 0, 'bundled runtime lib/bin.js non-empty') && ok;
  }
  // P5: runtime materials the office view reads must ship (the layout-editor/
  // furniture family is production, NOT the excluded editor module).
  for (const re of REQUIRED_RESOURCE_PATTERNS) {
    const hit = [...names].some((n) => re.test(n));
    ok = check(hit, 'runtime material present: ' + re.source.replace(/\\/g, '')) && ok;
  }
  // deepest path guard (Windows MAX_PATH risk; zips tolerate long paths but
  // extraction tools differ — README recommends 7-Zip)
  const deepest = entries.reduce((a, e) => (e.name.length > a.length ? e.name : a), '');
  console.log('  [info] entries=' + entries.length + ' deepest=' + deepest.length + ' chars ' + JSON.stringify(deepest));
  if (deepest.length > 240) {
    console.log('  [warn] deepest entry exceeds 240 chars — users must extract with 7-Zip (Explorer extractor may fail)');
  }
  return ok;
}

// Artifact layouts: win zips / win-unpacked keep the artifact root at the zip
// root (DshCockpit.exe + resources/…); mac zips carry the .app bundle
// (DshCockpit.app/Contents/Resources/…). Names are normalized to a common
// root-relative shape (everything under `resources/`) so every assertion below
// is platform-independent.
const MAC_BUNDLE_PREFIX = 'DshCockpit.app/Contents/Resources/';

/** Normalize zip entry names to the common root-relative shape. */
function normalizeZipEntries(entries, isMac) {
  return entries.map((e) => {
    let name = e.name.replace(/\\/g, '/');
    if (isMac) {
      name = name.startsWith(MAC_BUNDLE_PREFIX)
        ? 'resources/' + name.slice(MAC_BUNDLE_PREFIX.length)
        : 'resources/_outside-bundle/' + name;
    }
    return { ...e, name, rawName: e.name };
  });
}

function verifyZip(zipPath, opts) {
  const sizeMB = Math.round(fs.statSync(zipPath).size / 1e6);
  console.log('[verify] zip: ' + path.basename(zipPath) + ' (' + sizeMB + ' MB)');
  const isMac = /-mac-/.test(zipPath);
  const entries = normalizeZipEntries(listZipEntries(zipPath), isMac);
  const layout = {
    exeName: isMac ? null : 'DshCockpit.exe',
    asarPath: 'resources/app.asar',
    updaterFeed: 'resources/app-update.yml',
  };
  let ok = verifyTree(() => entries, 'zip', { ...opts, ...layout });
  // P5: open app.asar inside the zip and gate its contents
  const asarEntry = entries.find((e) => e.name === layout.asarPath);
  if (!asarEntry) {
    console.log('  [FAIL] app.asar entry not found in zip');
    return false;
  }
  const buf = extractZipEntry(zipPath, { ...asarEntry, name: asarEntry.rawName });
  ok = verifyAsarEntries(listAsarEntries(buf), 'zip ' + path.basename(zipPath)) && ok;
  return ok;
}

function verifyDir(dir, opts) {
  const names = [];
  const prefix = opts.namePrefix || '';
  const walk = (d, rel) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else {
        let s = 0;
        try { s = fs.statSync(path.join(d, e.name)).size; } catch { /* ignore */ }
        names.push({ name: prefix + r, uncompSize: s });
      }
    }
  };
  walk(dir, '');
  console.log('[verify] dir: ' + dir);
  // win-unpacked: walk root IS the artifact root (DshCockpit.exe at top,
  // resources/ beside it). mac .app: walk root is Contents/Resources and
  // names are prefixed with `resources/` so every artifact-layout assertion
  // (asar path, updater feed, runtime materials) stays uniform.
  const isWin = path.basename(dir) === 'win-unpacked';
  const layout = {
    exeName: isWin ? 'DshCockpit.exe' : null,
    asarPath: 'resources/app.asar',
    updaterFeed: 'resources/app-update.yml',
  };
  let ok = verifyTree(() => names, 'dir', { ...opts, ...layout });
  // P5: gate the on-disk app.asar contents
  const asarFile = path.join(dir, isWin ? 'resources/app.asar' : 'app.asar');
  if (!fs.existsSync(asarFile)) {
    console.log('  [FAIL] app.asar not found at ' + asarFile);
    return false;
  }
  ok = verifyAsarEntries(listAsarEntries(asarFile), 'dir ' + dir) && ok;
  return ok;
}

/** Locate the mac .app bundle produced by a --dir build (arm64 + x64). */
function findMacApp() {
  for (const dir of ['mac-arm64', 'mac', 'mac-x64']) {
    const app = path.join(DIST, dir, 'DshCockpit.app');
    if (fs.existsSync(path.join(app, 'Contents', 'Resources'))) {
      return path.join(app, 'Contents', 'Resources');
    }
  }
  return null;
}

/** Main entry: verify dist artifacts; exit 1 on failure (build aborts). */
function verify(opts = {}) {
  if (!fs.existsSync(DIST)) {
    console.log('[verify] no dist/ directory — nothing to verify');
    return true;
  }
  const allZips = fs.readdirSync(DIST).filter((f) => /^DshCockpit-.*\.zip$/.test(f)).sort();
  // Only artifacts of THIS build's version are gated: dist/ accumulates zips
  // from older builds (e.g. pre-office 0.2.9) and failing them against
  // current gates would report stale artifacts, not this build's output.
  const zips = opts.version
    ? allZips.filter((z) => z.startsWith('DshCockpit-' + opts.version + '-'))
    : allZips;
  let ok = true;
  let checked = 0;
  if (zips.length) {
    for (const z of zips) {
      // per-artifact slim detection: the -slim- name segment means no bundled
      // runtime by design, so the runtime-presence assertions must not run
      const isSlim = /-slim-/.test(z);
      ok = verifyZip(path.join(DIST, z), { ...opts, slim: isSlim || !!opts.slim }) && ok;
      checked++;
    }
  }
  if (!checked) {
    const unpacked = path.join(DIST, 'win-unpacked');
    const macResources = findMacApp();
    if (fs.existsSync(unpacked)) {
      ok = verifyDir(unpacked, opts) && ok;
    } else if (macResources) {
      // mac --dir builds land in dist/mac-arm64/DshCockpit.app — the asar
      // gates must run there too (P5: same artifact hygiene on every track).
      // The walk root is Contents/Resources; names are prefixed with
      // `resources/` so every artifact-layout assertion stays uniform.
      ok = verifyDir(macResources, { ...opts, namePrefix: 'resources/' }) && ok;
    } else {
      console.log('[verify] no current-version artifact (zip/win-unpacked/mac .app) found — skipping');
    }
  }
  return ok;
}

module.exports = { verify, listZipEntries, listAsarEntries, extractZipEntry };

if (require.main === module) {
  // Manual runs default to the current package version so stale dist/ zips
  // from older builds are not failed against today's gates.
  let version;
  try {
    version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch { /* version-less run gates every zip (explicit audit mode) */ }
  process.exit(verify({ version }) ? 0 : 1);
}
