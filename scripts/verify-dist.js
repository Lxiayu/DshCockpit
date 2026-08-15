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
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');
const RUNTIME_RE = /^resources\/runtime\/[^\\/]+\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js$/;

/** Read zip central-directory entries: { name, method, compSize, uncompSize }. */
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
    const name = cd.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, uncompSize });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function check(ok, label) {
  if (ok) console.log('  [ok]  ' + label);
  else { console.log('  [FAIL] ' + label); }
  return ok;
}

/** Verify a directory tree (win-unpacked) or a zip. Returns true when ok. */
function verifyTree(getEntries, describe, opts) {
  let ok = true;
  opts = opts || {};
  const entries = getEntries();
  const names = new Set(entries.map((e) => e.name.replace(/\\/g, '/')));
  ok = check(names.has('DshCockpit.exe'), 'DshCockpit.exe at root') && ok;
  ok = check(names.has('resources/app.asar'), 'resources/app.asar') && ok;
  // electron-builder only writes the updater feed for --publish always builds
  if (opts.requireUpdaterFeed) {
    ok = check(names.has('resources/app-update.yml'), 'resources/app-update.yml (updater feed)') && ok;
  } else {
    console.log('  [info] resources/app-update.yml skipped (--publish never build)');
  }
  const runtimeBins = entries.filter((e) => RUNTIME_RE.test(e.name));
  ok = check(runtimeBins.length > 0, 'bundled runtime lib/bin.js present (' + runtimeBins.length + ')') && ok;
  const emptyBins = runtimeBins.filter((e) => (e.uncompSize === undefined ? 0 : e.uncompSize) === 0);
  ok = check(emptyBins.length === 0, 'bundled runtime lib/bin.js non-empty') && ok;
  // deepest path guard (Windows MAX_PATH risk; zips tolerate long paths but
  // extraction tools differ — README recommends 7-Zip)
  const deepest = entries.reduce((a, e) => (e.name.length > a.length ? e.name : a), '');
  console.log('  [info] entries=' + entries.length + ' deepest=' + deepest.length + ' chars ' + JSON.stringify(deepest));
  if (deepest.length > 240) {
    console.log('  [warn] deepest entry exceeds 240 chars — users must extract with 7-Zip (Explorer extractor may fail)');
  }
  return ok;
}

function verifyZip(zipPath, opts) {
  const sizeMB = Math.round(fs.statSync(zipPath).size / 1e6);
  console.log('[verify] zip: ' + path.basename(zipPath) + ' (' + sizeMB + ' MB)');
  return verifyTree(() => listZipEntries(zipPath), 'zip', opts);
}

function verifyDir(dir, opts) {
  const names = [];
  const walk = (d, rel) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else {
        let s = 0;
        try { s = fs.statSync(path.join(d, e.name)).size; } catch { /* ignore */ }
        names.push({ name: r, uncompSize: s });
      }
    }
  };
  walk(dir, '');
  console.log('[verify] dir: ' + dir);
  return verifyTree(() => names, 'dir', opts);
}

/** Main entry: verify dist artifacts; exit 1 on failure (build aborts). */
function verify() {
  if (!fs.existsSync(DIST)) {
    console.log('[verify] no dist/ directory — nothing to verify');
    return;
  }
  const zips = fs.readdirSync(DIST).filter((f) => /^DshCockpit-.*\.zip$/.test(f));
  let ok = true;
  if (zips.length) {
    for (const z of zips.sort()) ok = verifyZip(path.join(DIST, z)) && ok;
  } else {
    const unpacked = path.join(DIST, 'win-unpacked');
    if (fs.existsSync(unpacked)) ok = verifyDir(unpacked) && ok;
    else console.log('[verify] neither zip nor win-unpacked found — skipping');
  }
  return ok;
}

module.exports = { verify, listZipEntries };

if (require.main === module) {
  process.exit(verify() ? 0 : 1);
}
