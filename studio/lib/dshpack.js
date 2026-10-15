'use strict';

// studio/lib/dshpack.js — the portable project container (brief §7A/§14).
//
// A .dshpack is a zip holding the project's content plus a machine-readable
// manifest:
//
//   manifest.json                 { schemaVersion, id, label, kind, createdAt,
//                                   studioVersion, layout, contents, files[] }
//   <project files…>              project.json + characters/ scenes/ graphs/
//                                 dialogues/ provenance/ (tool output excluded)
//
// Three properties matter and are enforced here:
//   1. CONTENT-DERIVED: the manifest lists every entry with its byte length and
//      sha256, so "did the round trip preserve the assets?" is a hash question,
//      not a vibe. The archive bytes themselves are deterministic for the same
//      content (fixed zip timestamps).
//   2. FAIL-CLOSED ON SECRETS: every text entry passes studio/lib/scan.js before
//      anything is written; a hit aborts the export (brief §10.3).
//   3. FRIENDLY FAILURES: a missing/extra entry, a hash mismatch, an unsupported
//      manifest version or a non-empty import target each produce a stable code
//      and a message a human can act on — never a silent partial import.

const path = require('node:path');
const fs = require('node:fs');

const zip = require('./zip.js');
const scan = require('./scan.js');
const projectLib = require('./project.js');

const MANIFEST_NAME = 'manifest.json';
const PACK_SCHEMA_VERSION = 1;
const STUDIO_VERSION = '0.1.0';

const TEXT_SUFFIXES = new Set(['.json', '.md', '.txt', '.csv', '.js', '.css', '.html', '.svg']);
// Deterministic archive timestamps: content-derived bytes, not clock-derived.
const FIXED_MTIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

function nowIso(clock) {
  return typeof clock === 'function' ? new Date(clock()).toISOString() : new Date().toISOString();
}

function isTextEntry(relPath) {
  return TEXT_SUFFIXES.has(path.extname(relPath).toLowerCase());
}

function buildManifest({ project, described, createdAt }) {
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    kind: project.kind,
    id: project.id,
    label: project.label,
    createdAt,
    studioVersion: STUDIO_VERSION,
    layout: project.layout,
    contents: {
      files: described.files.length,
      totalBytes: described.totalBytes,
      bySuffix: described.bySuffix,
      digest: described.digest,
      counts: described.counts,
    },
    files: described.files,
  };
}

// ---- export ------------------------------------------------------------------

function exportPack({ root, project, out, clock, dryRun = false }) {
  if (!project) {
    const loaded = projectLib.loadProject({ root });
    if (!loaded.ok) return { ok: false, code: loaded.code, message: loaded.message, violations: loaded.violations || [] };
    project = loaded.project;
  }
  const described = projectLib.describeProject({ root, project });
  if (described.files.length === 0) {
    return { ok: false, code: 'PACK_EMPTY', message: 'the project has no content files to pack' };
  }
  const manifest = buildManifest({ project, described, createdAt: nowIso(clock) });

  // Secret gate + entry collection. Text is scanned here, before any write.
  const entries = [];
  const violations = [];
  for (const file of described.files) {
    const abs = path.join(root, file.path);
    const data = fs.readFileSync(abs);
    if (isTextEntry(file.path)) {
      const outcome = scan.scanForSecrets(data.toString('utf8'));
      if (!outcome.ok) {
        violations.push({
          check: 'export.secret-shape',
          path: file.path,
          detail: `refused: ${outcome.hits.map((hit) => `${hit.code}@${hit.index}(${hit.fingerprint})`).join(', ')}`,
        });
        continue;
      }
    }
    entries.push({ path: file.path, data });
  }
  if (violations.length > 0) {
    // fail-closed: nothing is written when any entry leaks a key shape
    return { ok: false, code: 'PACK_SECRET_SHAPE_REFUSED', violations, message: 'export refused: secret-shaped strings found (never export keys)' };
  }

  const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const archiveEntries = [{ path: MANIFEST_NAME, data: manifestData }, ...entries];
  const archive = zip.writeZip(archiveEntries, { mtime: FIXED_MTIME });
  if (dryRun) {
    return { ok: true, dryRun: true, out: null, manifest, bytes: archive.length, packSha256: projectLib.sha256(archive) };
  }
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, archive);
  }
  return {
    ok: true,
    dryRun: false,
    out: out || null,
    manifest,
    entries: archiveEntries.length,
    bytes: archive.length,
    packSha256: projectLib.sha256(archive),
    digest: described.digest,
  };
}

// ---- inspect / import --------------------------------------------------------

// The container speaks its own error vocabulary: a caller (panel, CLI) should
// never have to know that the payload happens to be a zip.
const ZIP_TO_PACK_CODE = {
  ZIP_NOT_ARCHIVE: 'PACK_NOT_ARCHIVE',
  ZIP_TRUNCATED: 'PACK_TRUNCATED',
  ZIP_UNSAFE_PATH: 'PACK_UNSAFE_PATH',
  ZIP_UNSUPPORTED: 'PACK_UNSUPPORTED',
  ZIP_TOO_LARGE: 'PACK_TOO_LARGE',
};

function readPack(file) {
  let archive;
  if (!fs.existsSync(file)) {
    return { ok: false, code: 'PACK_FILE_MISSING', message: `no such pack: ${file}` };
  }
  try {
    archive = zip.readZip(file);
  } catch (error) {
    const code = ZIP_TO_PACK_CODE[error.code] || 'PACK_UNREADABLE';
    return { ok: false, code, message: error.message };
  }
  const manifestEntry = archive.find((entry) => entry.path === MANIFEST_NAME);
  if (!manifestEntry) return { ok: false, code: 'PACK_MANIFEST_MISSING', message: `${MANIFEST_NAME} is not in the archive` };
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch (error) {
    return { ok: false, code: 'PACK_MANIFEST_UNPARSEABLE', message: error.message };
  }
  return { ok: true, archive, manifest };
}

function inspectPack({ file }) {
  const read = readPack(file);
  if (!read.ok) return read;
  const { archive, manifest } = read;
  const problems = [];
  if (manifest.schemaVersion !== PACK_SCHEMA_VERSION) {
    problems.push({ check: 'pack.schemaVersion', detail: `pack schemaVersion ${JSON.stringify(manifest.schemaVersion)} is not supported by this studio (expected ${PACK_SCHEMA_VERSION})` });
  }
  const declared = new Map((manifest.files || []).map((entry) => [entry.path, entry]));
  const present = new Map(archive.filter((entry) => entry.path !== MANIFEST_NAME).map((entry) => [entry.path, entry]));
  for (const [relPath, entry] of declared) {
    const found = present.get(relPath);
    if (!found) {
      problems.push({ check: 'pack.entry-missing', path: relPath, detail: 'declared in the manifest but absent from the archive' });
      continue;
    }
    const digest = projectLib.sha256(found.data);
    if (digest !== entry.sha256) {
      problems.push({ check: 'pack.hash-mismatch', path: relPath, detail: `archive bytes hash ${digest.slice(0, 12)}… but the manifest declares ${String(entry.sha256).slice(0, 12)}…` });
    }
  }
  for (const relPath of present.keys()) {
    if (!declared.has(relPath)) problems.push({ check: 'pack.entry-unexpected', path: relPath, detail: 'present in the archive but not declared (refusing to silently drop it)' });
  }
  return {
    ok: problems.length === 0,
    code: problems.length === 0 ? null : 'PACK_PROBLEMS',
    file,
    manifest,
    entries: archive.length,
    problems,
    compatible: manifest.schemaVersion === PACK_SCHEMA_VERSION,
  };
}

function importPack({ file, dest, overwrite = false, dryRun = false }) {
  const inspected = inspectPack({ file });
  // An unsupported manifest version is the most actionable failure: report it
  // before the hash/missing-entry noise it inevitably drags along.
  if (inspected.manifest && inspected.compatible === false) {
    return {
      ok: false,
      code: 'PACK_SCHEMA_UNSUPPORTED',
      file,
      dest,
      manifest: inspected.manifest,
      message: `this pack declares manifest schemaVersion ${JSON.stringify(inspected.manifest.schemaVersion)}; this studio reads ${PACK_SCHEMA_VERSION}`,
      problems: inspected.problems || [],
      written: [],
    };
  }
  if (!inspected.ok) return { ...inspected, written: [], dest };
  const destination = path.resolve(dest);
  const projectFile = path.join(destination, projectLib.PROJECT_FILE);
  if (!overwrite && fs.existsSync(projectFile)) {
    return {
      ok: false,
      code: 'IMPORT_TARGET_NOT_EMPTY',
      file,
      dest: destination,
      message: `${projectLib.PROJECT_FILE} already exists in the target — pass overwrite to replace this project`,
      written: [],
    };
  }
  const read = readPack(file);
  const members = read.archive.filter((entry) => entry.path !== MANIFEST_NAME);
  const written = [];
  if (!dryRun) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of members) {
      // readZip already rejected unsafe paths; assert again because this is the
      // last gate before touching the filesystem.
      zip.assertSafePath(entry.path);
      const abs = path.join(destination, entry.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, entry.data);
      written.push(entry.path);
    }
  }
  return {
    ok: true,
    file,
    dest: destination,
    dryRun,
    manifest: inspected.manifest,
    written,
    counts: { files: members.length, bytes: members.reduce((sum, entry) => sum + entry.data.length, 0) },
  };
}

// ---- round-trip verification -------------------------------------------------
//
// exportPack → importPack → compare the content digests. This is the tool's
// answer to "真资产往返一致（哈希不变）" and it is what the panel button calls.

function verifyRoundTrip({ root, project, tmpDir, clock }) {
  const workDir = tmpDir || fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dshpack-rt-'));
  const owned = !tmpDir;
  try {
    const packFile = path.join(workDir, 'roundtrip.dshpack');
    const exported = exportPack({ root, project, out: packFile, clock });
    if (!exported.ok) return { ok: false, stage: 'export', detail: exported };
    const dest = path.join(workDir, 'imported');
    const imported = importPack({ file: packFile, dest });
    if (!imported.ok) return { ok: false, stage: 'import', detail: imported };
    const loaded = projectLib.loadProject({ root: dest });
    if (!loaded.ok) return { ok: false, stage: 'load', detail: loaded };
    const before = projectLib.describeProject({ root, project });
    const after = projectLib.describeProject({ root: dest, project: loaded.project });
    const beforeByPath = new Map(before.files.map((entry) => [entry.path, entry.sha256]));
    const afterByPath = new Map(after.files.map((entry) => [entry.path, entry.sha256]));
    const changed = [];
    for (const [relPath, digest] of beforeByPath) {
      if (!afterByPath.has(relPath)) changed.push({ path: relPath, issue: 'missing-after-import' });
      else if (afterByPath.get(relPath) !== digest) changed.push({ path: relPath, issue: 'hash-changed' });
    }
    for (const relPath of afterByPath.keys()) if (!beforeByPath.has(relPath)) changed.push({ path: relPath, issue: 'extra-after-import' });
    return {
      ok: changed.length === 0,
      stage: changed.length === 0 ? 'done' : 'compare',
      packFile,
      packSha256: exported.packSha256,
      beforeDigest: before.digest,
      afterDigest: after.digest,
      files: before.files.length,
      changed,
    };
  } finally {
    if (owned) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = {
  FIXED_MTIME,
  MANIFEST_NAME,
  PACK_SCHEMA_VERSION,
  STUDIO_VERSION,
  TEXT_SUFFIXES,
  buildManifest,
  exportPack,
  importPack,
  inspectPack,
  isTextEntry,
  readPack,
  verifyRoundTrip,
};
