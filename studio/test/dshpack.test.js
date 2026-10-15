'use strict';

// studio/test/dshpack.test.js — the project model and the .dshpack container.
//
// The acceptance that matters (brief §9 P1): 真鲸鱼娘资产往返后哈希不变.
// The test exports the REAL content/ project, imports it into a temp folder and
// compares every file's sha256 — plus the failure paths a user will hit
// (unsupported version, missing entry, tampered bytes, non-empty target,
// secret shapes) which must fail loudly instead of importing half a project.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
const CONTENT_ROOT = path.join(REPO_ROOT, 'content');

const projectLib = require(path.join(STUDIO_ROOT, 'lib', 'project.js'));
const dshpack = require(path.join(STUDIO_ROOT, 'lib', 'dshpack.js'));
const zip = require(path.join(STUDIO_ROOT, 'lib', 'zip.js'));

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpack-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function loadRealProject() {
  const loaded = projectLib.loadProject({ root: CONTENT_ROOT });
  assert.equal(loaded.ok, true, `content/project.json loads (${JSON.stringify(loaded.violations || loaded.code)})`);
  return loaded;
}

test('the real content tree is a valid project with every declared path present', () => {
  const loaded = loadRealProject();
  assert.equal(loaded.project.id, 'whale-office');
  assert.equal(loaded.project.schemaVersion, 1);
  const missing = projectLib.missingPaths(loaded.layout);
  assert.deepEqual(missing, [], 'every declared domain path exists on disk');
  // declared domains resolve to the real whale-girl tree
  const characters = loaded.layout.characters.map((entry) => entry.path);
  assert.deepEqual(characters, ['characters/whale-girl']);
  assert.ok(loaded.layout.dialogues.some((entry) => entry.path === 'shared/dialogue'));
  assert.ok(loaded.layout.provenance.some((entry) => entry.path === 'characters/whale-girl/provenance'));
});

test('describeProject lists the real files, excludes tool output, and digests content-only', () => {
  const loaded = loadRealProject();
  const described = projectLib.describeProject({ root: CONTENT_ROOT, project: loaded.project });
  assert.ok(described.files.length > 50, `real project has content files (${described.files.length})`);
  assert.ok(described.totalBytes > 1_000_000, `real project is not tiny (${described.totalBytes} bytes)`);
  const paths = described.files.map((file) => file.path);
  assert.ok(paths.includes('project.json'), 'the project file travels with the pack');
  assert.ok(paths.some((rel) => rel.endsWith('.png')), 'character/furniture art travels');
  assert.ok(paths.some((rel) => rel.startsWith('characters/whale-girl/actions/')), 'action docs travel');
  assert.ok(paths.some((rel) => rel.startsWith('scenes/flat/')), 'scene docs travel');
  assert.equal(paths.some((rel) => rel.startsWith('build/')), false, 'tool output (build/) never travels');
  assert.equal(paths.some((rel) => rel.includes('.DS_Store')), false);
  for (const file of described.files) assert.match(file.sha256, /^[0-9a-f]{64}$/);
  // digest is content-derived: same files ⇒ same digest
  const again = projectLib.describeProject({ root: CONTENT_ROOT, project: loaded.project });
  assert.equal(again.digest, described.digest);
});

test('REAL ROUND TRIP: export → import → every whale-girl byte is identical', (t) => {
  const dir = sandbox(t);
  const loaded = loadRealProject();
  const before = projectLib.describeProject({ root: CONTENT_ROOT, project: loaded.project });
  const packFile = path.join(dir, 'whale-office.dshpack');

  const exported = dshpack.exportPack({ root: CONTENT_ROOT, project: loaded.project, out: packFile });
  assert.equal(exported.ok, true, `export ok (${exported.code || ''} ${JSON.stringify(exported.violations || [])})`);
  assert.ok(fs.existsSync(packFile));
  assert.ok(exported.bytes > 1_000_000, `pack carries the real payload (${exported.bytes} bytes)`);
  assert.equal(exported.manifest.contents.files, before.files.length);
  assert.equal(exported.manifest.contents.digest, before.digest, 'the manifest digest is the source digest');

  const dest = path.join(dir, 'imported');
  const imported = dshpack.importPack({ file: packFile, dest });
  assert.equal(imported.ok, true, `import ok (${imported.code || ''})`);

  const reloaded = projectLib.loadProject({ root: dest });
  assert.equal(reloaded.ok, true, 'the imported tree is a loadable project');
  const after = projectLib.describeProject({ root: dest, project: reloaded.project });
  assert.equal(after.files.length, before.files.length, 'no file lost or added');
  assert.equal(after.digest, before.digest, 'HASH-STABLE: the round trip changes no content byte');

  const beforeByPath = new Map(before.files.map((file) => [file.path, file.sha256]));
  for (const file of after.files) {
    assert.equal(file.sha256, beforeByPath.get(file.path), `${file.path} survives byte-identical`);
  }
  // the pack is deterministic for the same content AND the same createdAt: the
  // zip timestamps are fixed, so createdAt is the only clock dependency.
  const fixedClock = () => Date.UTC(2026, 8, 27, 0, 0, 0);
  const second = dshpack.exportPack({ root: CONTENT_ROOT, project: loaded.project, out: path.join(dir, 'again.dshpack'), clock: fixedClock });
  const third = dshpack.exportPack({ root: CONTENT_ROOT, project: loaded.project, out: path.join(dir, 'third.dshpack'), clock: fixedClock });
  assert.equal(second.packSha256, third.packSha256, 'same content + same createdAt ⇒ byte-identical archives');
  const later = dshpack.exportPack({ root: CONTENT_ROOT, project: loaded.project, out: path.join(dir, 'later.dshpack'), clock: () => Date.UTC(2026, 8, 28) });
  assert.notEqual(later.packSha256, second.packSha256, 'createdAt is recorded in the manifest (a later export differs by that field alone)');
});

test('verifyRoundTrip() is the one-call form of the same acceptance', (t) => {
  const dir = sandbox(t);
  const loaded = loadRealProject();
  const outcome = dshpack.verifyRoundTrip({ root: CONTENT_ROOT, project: loaded.project, tmpDir: dir });
  assert.equal(outcome.ok, true, `round trip clean (${outcome.stage} ${JSON.stringify(outcome.changed || [])})`);
  assert.equal(outcome.beforeDigest, outcome.afterDigest);
  assert.ok(outcome.files > 50);
  assert.match(outcome.packSha256, /^[0-9a-f]{64}$/);
});

test('the manifest lists every entry with its hash and the pack is inspectable', (t) => {
  const dir = sandbox(t);
  const loaded = loadRealProject();
  const packFile = path.join(dir, 'inspect.dshpack');
  dshpack.exportPack({ root: CONTENT_ROOT, project: loaded.project, out: packFile });
  const inspected = dshpack.inspectPack({ file: packFile });
  assert.equal(inspected.ok, true, `clean pack inspects clean (${JSON.stringify(inspected.problems || [])})`);
  assert.equal(inspected.compatible, true);
  assert.equal(inspected.manifest.files.length + 1, inspected.entries, 'manifest + one entry per file');
  assert.deepEqual(inspected.problems, []);
  // every declared entry is really inside the archive
  const archive = zip.listZip(packFile);
  const names = new Set(archive.map((entry) => entry.path));
  for (const file of inspected.manifest.files) assert.ok(names.has(file.path), `${file.path} is in the archive`);
});

test('a tampered archive fails inspection with the exact path named', (t) => {
  const dir = sandbox(t);
  const loaded = loadRealProject();
  const packFile = path.join(dir, 'tamper.dshpack');
  const exported = dshpack.exportPack({ root: CONTENT_ROOT, project: loaded.project, out: packFile });

  // rebuild the archive with one entry's bytes changed but the manifest untouched
  const entries = zip.readZip(packFile);
  const target = entries.find((entry) => entry.path.endsWith('.json') && entry.path !== dshpack.MANIFEST_NAME);
  const tampered = entries.map((entry) => (
    entry.path === target.path ? { path: entry.path, data: Buffer.from(`${entry.data.toString('utf8')}\n`) } : { path: entry.path, data: entry.data }
  ));
  const tamperFile = path.join(dir, 'tampered.dshpack');
  fs.writeFileSync(tamperFile, zip.writeZip(tampered, { mtime: dshpack.FIXED_MTIME }));

  const inspected = dshpack.inspectPack({ file: tamperFile });
  assert.equal(inspected.ok, false);
  const mismatch = inspected.problems.find((problem) => problem.check === 'pack.hash-mismatch');
  assert.ok(mismatch, `hash mismatch reported (${JSON.stringify(inspected.problems)})`);
  assert.equal(mismatch.path, target.path, 'the offending path is named');

  // and importing it is refused, not partially applied
  const dest = path.join(dir, 'refused');
  const imported = dshpack.importPack({ file: tamperFile, dest });
  assert.equal(imported.ok, false);
  assert.equal(fs.existsSync(path.join(dest, 'project.json')), false, 'a refused import writes nothing');

  // the untouched pack still carries the exported manifest digest
  assert.equal(exported.manifest.contents.digest, dshpack.inspectPack({ file: packFile }).manifest.contents.digest);
});

test('an unsupported pack version is refused with a human message', (t) => {
  const dir = sandbox(t);
  const loaded = loadRealProject();
  const described = projectLib.describeProject({ root: CONTENT_ROOT, project: loaded.project });
  const manifest = dshpack.buildManifest({ project: loaded.project, described, createdAt: '2026-09-27T00:00:00.000Z' });
  manifest.schemaVersion = 99;
  const file = path.join(dir, 'future.dshpack');
  fs.writeFileSync(file, zip.writeZip([
    { path: dshpack.MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { path: 'project.json', data: fs.readFileSync(path.join(CONTENT_ROOT, 'project.json')) },
  ], { mtime: dshpack.FIXED_MTIME }));

  const inspected = dshpack.inspectPack({ file });
  assert.equal(inspected.ok, false);
  assert.equal(inspected.compatible, false);
  assert.ok(inspected.problems.some((problem) => problem.check === 'pack.schemaVersion'));

  const imported = dshpack.importPack({ file, dest: path.join(dir, 'dest') });
  assert.equal(imported.ok, false);
  assert.equal(imported.code, 'PACK_SCHEMA_UNSUPPORTED');
});

test('a manifest declaring a missing entry is refused (no silent partial project)', (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, 'incomplete.dshpack');
  const manifest = {
    schemaVersion: 1,
    kind: 'scene-authoring',
    id: 'demo',
    label: 'demo',
    files: [
      { path: 'project.json', bytes: 10, sha256: 'f'.repeat(64) },
      { path: 'characters/ghost/actions/x.json', bytes: 1, sha256: 'a'.repeat(64) },
    ],
  };
  fs.writeFileSync(file, zip.writeZip([
    { path: dshpack.MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { path: 'project.json', data: Buffer.from('{}', 'utf8') },
  ], { mtime: dshpack.FIXED_MTIME }));
  const inspected = dshpack.inspectPack({ file });
  assert.equal(inspected.ok, false);
  const missing = inspected.problems.find((problem) => problem.check === 'pack.entry-missing');
  assert.equal(missing.path, 'characters/ghost/actions/x.json');
  assert.ok(inspected.problems.some((problem) => problem.check === 'pack.hash-mismatch'), 'the present-but-different file is also called out');
});

test('importing over an existing project needs an explicit overwrite', (t) => {
  const dir = sandbox(t);
  const loaded = loadRealProject();
  const packFile = path.join(dir, 'target.dshpack');
  dshpack.exportPack({ root: CONTENT_ROOT, project: loaded.project, out: packFile });
  const dest = path.join(dir, 'existing');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'project.json'), '{"schemaVersion":1}\n');

  const refused = dshpack.importPack({ file: packFile, dest });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'IMPORT_TARGET_NOT_EMPTY');
  assert.equal(fs.readFileSync(path.join(dest, 'project.json'), 'utf8'), '{"schemaVersion":1}\n', 'the existing file is untouched');

  const forced = dshpack.importPack({ file: packFile, dest, overwrite: true });
  assert.equal(forced.ok, true);
  assert.equal(projectLib.loadProject({ root: dest }).ok, true);
});

test('export refuses to pack a project containing key-shaped text (fail-closed)', (t) => {
  const dir = sandbox(t);
  const root = path.join(dir, 'leaky');
  const created = projectLib.createProject({ root, id: 'leaky-project', label: 'leaky' });
  assert.equal(created.ok, true);
  fs.mkdirSync(path.join(root, 'characters/whale-girl/actions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'characters/whale-girl/actions/walk.json'), `${JSON.stringify({ schemaVersion: 1, apiKey: 'sk-' + 'A'.repeat(40) })}\n`);

  const outcome = dshpack.exportPack({ root, project: created.project, out: path.join(dir, 'leak.dshpack') });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'PACK_SECRET_SHAPE_REFUSED');
  assert.ok(outcome.violations.some((violation) => violation.path.endsWith('walk.json')));
  assert.equal(fs.existsSync(path.join(dir, 'leak.dshpack')), false, 'nothing is written when the gate trips');
  // the report never carries the value
  assert.doesNotMatch(JSON.stringify(outcome.violations), /A{20}/);
});

test('createProject writes a project the loader accepts, and refuses to clobber one', (t) => {
  const dir = sandbox(t);
  const root = path.join(dir, 'fresh');
  const created = projectLib.createProject({ root, id: 'fresh-project', label: '新项目' });
  assert.equal(created.ok, true);
  assert.equal(fs.existsSync(path.join(root, 'project.json')), true);
  const loaded = projectLib.loadProject({ root });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.project.id, 'fresh-project');
  // a fresh project has declared-but-empty domains: reported, not fatal
  const missing = projectLib.missingPaths(loaded.layout);
  assert.ok(missing.length > 0, 'the empty project honestly reports its missing domains');

  const again = projectLib.createProject({ root, id: 'other', label: '别的' });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'PROJECT_EXISTS');
});

test('project validation names every bad field', () => {
  const bad = {
    schemaVersion: 2,
    id: 'Bad Id',
    label: '',
    kind: '',
    layout: { characters: [{ path: '../escape' }], scenes: 'nope', graphs: [], dialogues: [], provenance: [] },
  };
  const outcome = projectLib.validateProject(bad);
  assert.equal(outcome.ok, false);
  const checks = outcome.violations.map((violation) => violation.check);
  for (const expected of ['project.schemaVersion', 'project.id', 'project.label', 'project.kind', 'project.layout.characters[0]', 'project.layout.scenes']) {
    assert.ok(checks.includes(expected), `${expected} reported (got ${checks.join(',')})`);
  }
});
