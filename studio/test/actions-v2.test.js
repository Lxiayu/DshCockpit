'use strict';

// studio/test/actions-v2.test.js — action schema v2, the review notes and the
// publish-down compile (P3).
//
// The phase acceptance (brief §9 P3) is "真资产走通审片→改→发布": the test below
// migrates the REAL action docs to v2 in a sandbox, adds frame-anchored notes,
// publishes the edited action through the REAL publish kernel into a sandbox pack
// and then runs the STRICT production validator over that pack. Nothing touches
// the user's pack or content tree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
const CONTENT_ROOT = path.join(REPO_ROOT, 'content');
const CHARACTERS_ROOT = path.join(REPO_ROOT, 'resources', 'characters');
const PACK_ID = 'deepseek-default';

const schema = require(path.join(STUDIO_ROOT, 'lib', 'actions', 'schema.js'));
const notesLib = require(path.join(STUDIO_ROOT, 'lib', 'actions', 'notes.js'));
const publisher = require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'action-publisher.js'));
const { createActionServices } = require(path.join(STUDIO_ROOT, 'lib', 'actions', 'service.js'));

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-v2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A full sandbox copy: content/characters/<id> + resources/characters/<pack>, so a
// publish can run the real kernel end to end without touching the repository.
function sandboxProject(t) {
  const dir = sandbox(t);
  const contentDir = path.join(dir, 'content');
  const charactersRoot = path.join(dir, 'resources', 'characters');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(charactersRoot, { recursive: true });
  fs.cpSync(path.join(CONTENT_ROOT, 'characters'), path.join(contentDir, 'characters'), { recursive: true });
  fs.cpSync(path.join(CHARACTERS_ROOT, PACK_ID), path.join(charactersRoot, PACK_ID), { recursive: true });
  const services = createActionServices({ repoRoot: REPO_ROOT, contentDir, charactersRoot, publisher });
  return { dir, contentDir, charactersRoot, services };
}

function realServices() {
  return createActionServices({ repoRoot: REPO_ROOT, contentDir: CONTENT_ROOT, charactersRoot: CHARACTERS_ROOT, publisher });
}

test('every real action doc is v2 on disk (migrated 2026-09-28) and parses losslessly', () => {
  const services = realServices();
  const rows = services.list().actions.filter((row) => row.hasDoc);
  assert.equal(rows.length, 8, 'eight content action docs');
  for (const row of rows) {
    // the real docs were migrated with `actions migrate --all` (backups under
    // content/build/backups/actions/); this pins the state so a silent downgrade shows
    assert.equal(row.schemaVersion, 2, `${row.id} is v2 on disk`);
    const shown = services.show(row.id);
    assert.equal(shown.ok, true);
    assert.equal(shown.doc.schemaVersion, 2, `${row.id} parses as v2`);
    // the walk actions carry the factual `walk` tag (added 2026-09-28 with the widened
    // pack contract); anything else must still be an empty list
    const expectedTags = row.id.startsWith('walk-') ? ['walk'] : [];
    assert.deepEqual(shown.doc.tags, expectedTags, `${row.id} tags`);
    assert.deepEqual(shown.doc.events, [], 'no events yet');
    assert.equal(shown.doc.pingPong, false);
    // the compile-down is exactly the doc's runtime subset
    assert.equal(shown.runtime.runtimeSafe, true);
    assert.deepEqual(shown.runtime.dropped, [], 'a plain v1 doc drops nothing');
    assert.deepEqual(shown.runtime.entry.frames.map((frame) => frame.file), shown.doc.frames.map((frame) => frame.file));
    assert.equal(shown.runtime.inSync, true, `${row.id} matches its pack entry`);
  }
});

test('a v1 doc still migrates to v2 (the migration path itself)', (t) => {
  const dir = sandbox(t);
  // the publish kernel's createPaths pins the character project directory, so the
  // sandbox mirrors that shape (content/characters/whale-girl/actions)
  const actionsDir = path.join(dir, 'content', 'characters', 'whale-girl', 'actions');
  fs.mkdirSync(actionsDir, { recursive: true });
  const v1 = { schemaVersion: 1, id: 'legacy', loop: true, direction: 'left', frames: [{ file: 'a/b.png', durationMs: null }], geometry: { footLine: 296, tolerancePx: 1 } };
  fs.writeFileSync(path.join(actionsDir, 'legacy.json'), JSON.stringify(v1));
  const publisher = require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'action-publisher.js'));
  const services = createActionServices({ repoRoot: REPO_ROOT, contentDir: path.join(dir, 'content'), charactersRoot: path.join(dir, 'characters'), publisher });
  const migrated = services.migrate('legacy');
  assert.equal(migrated.ok, true, `migration ran (${migrated.code || ''})`);
  assert.equal(migrated.noop, false, 'a v1 doc is really rewritten');
  const after = JSON.parse(fs.readFileSync(path.join(actionsDir, 'legacy.json'), 'utf8'));
  assert.equal(after.schemaVersion, 2);
  assert.deepEqual(after.tags, [], 'v2 defaults are explicit');
  assert.deepEqual(after.events, []);
  assert.equal(after.pingPong, false);
  assert.ok(fs.existsSync(migrated.backup), 'the previous file is backed up');
  const again = services.migrate('legacy');
  assert.equal(again.noop, true, 'migration is idempotent');
});

test('the runtime compile-down carries the v2 metadata the pack now accepts', () => {
  const rich = {
    schemaVersion: 2,
    id: 'walk-left',
    loop: true,
    pingPong: true,
    direction: 'left',
    frames: [
      { file: 'assets/animations/walk/left/walk-left-b01.png', durationMs: null },
      { file: 'assets/animations/walk/left/walk-left-b02.png', durationMs: 120 },
      { file: 'assets/animations/walk/left/walk-left-b03.png', durationMs: null },
    ],
    geometry: { footLine: 296, tolerancePx: 1 },
    tags: ['walk', 'highlight'],
    events: [{ frame: 1, name: 'footstep', data: { side: 'left' } }],
  };
  const parsed = schema.parseActionDocV2(rich);
  assert.equal(parsed.ok, true, `v2 doc parses (${parsed.code || ''} ${parsed.message || ''})`);
  const compiled = schema.compileDown(parsed.doc);
  assert.equal(compiled.runtimeSafe, true);
  // P3 follow-up (2026-09-28): the pack carries the metadata now — nothing is dropped,
  // and pingPong keeps a documented caveat instead of a "dropped" verdict.
  assert.deepEqual(compiled.dropped, [], 'nothing is dropped: the widened pack carries metadata');
  assert.deepEqual(compiled.entry.tags, ['walk', 'highlight']);
  assert.equal(compiled.entry.pingPong, true);
  assert.deepEqual(compiled.entry.events, [{ frame: 1, name: 'footstep', data: { side: 'left' } }]);
  assert.ok(compiled.notes.some((note) => note.field === 'pingPong' && /forward order/.test(note.note)), 'the ping-pong caveat is recorded');
  const entryFields = Object.keys(compiled.entry).sort();
  assert.deepEqual(entryFields.filter((field) => !['direction', 'frames', 'loop', 'tags', 'pingPong', 'events'].includes(field)), [], 'no unexpected field appears');
  for (const frame of compiled.entry.frames) assert.deepEqual(Object.keys(frame).sort(), ['durationMs', 'file']);
});

test('v2 validation refuses malformed tags, events and ping-pong', () => {
  const base = { schemaVersion: 2, id: 'walk-left', loop: true, pingPong: false, direction: 'left', frames: [{ file: 'a/b.png', durationMs: null }], geometry: { footLine: 296, tolerancePx: 1 }, tags: [], events: [] };
  const cases = [
    { doc: { ...base, tags: ['Walk'] }, check: 'action.tags[]' },
    { doc: { ...base, tags: ['walk', 'walk'] }, check: 'action.tags[]' },
    { doc: { ...base, events: [{ frame: 5, name: 'footstep' }] }, check: 'action.events[0].frame' },
    { doc: { ...base, events: [{ frame: 0, name: 'Foot Step' }] }, check: 'action.events[0].name' },
    { doc: { ...base, pingPong: true }, check: 'action.pingPong' },
    { doc: { ...base, schemaVersion: 3 }, check: 'ACTION_SCHEMA_UNSUPPORTED' },
    { doc: { ...base, frames: [{ file: '../escape.png', durationMs: null }] }, check: 'ACTION_FRAME_INVALID' },
    { doc: { ...base, frames: [{ file: 'a/b.png', durationMs: 10 }] }, check: 'ACTION_DURATION_INVALID' },
  ];
  for (const { doc, check } of cases) {
    const parsed = schema.parseActionDocV2(doc);
    assert.equal(parsed.ok, false, `refused: ${JSON.stringify(doc.tags || doc.events || doc.frames || doc.schemaVersion)}`);
    const codes = [parsed.code, ...(parsed.violations || []).map((violation) => violation.check)];
    assert.ok(codes.includes(check), `expected ${check}, got ${codes.join(', ')}`);
  }
});

test('ping-pong playback wraps through the reversed middle (the bench player)', () => {
  const doc = {
    schemaVersion: 2, id: 'p', loop: true, pingPong: true, direction: 'none',
    frames: [{ file: 'a.png', durationMs: 100 }, { file: 'b.png', durationMs: 100 }, { file: 'c.png', durationMs: 100 }],
    geometry: { footLine: 296, tolerancePx: 1 }, tags: [], events: [],
  };
  const parsed = schema.parseActionDocV2(doc);
  const summary = schema.summarize(parsed.doc);
  assert.equal(summary.cycleMs, 400, 'a 3-frame ping-pong cycle costs 4 frames of time (a b c b), not 6');
  const seen = [];
  for (let t = 0; t < 400; t += 50) seen.push(schema.frameIndexAt(parsed.doc, t).index);
  assert.deepEqual([...new Set(seen)].sort(), [0, 1, 2]);
  assert.equal(schema.frameIndexAt(parsed.doc, 350).index, 1, 'the wrap returns through b');
  assert.equal(schema.frameIndexAt(parsed.doc, 0).index, 0);
});

test('review notes are frame-anchored, survive reorders visibly, and export as JSON', (t) => {
  const dir = sandbox(t);
  const actionsDir = path.join(dir, 'actions');
  const frames = [{ file: 'a/01.png' }, { file: 'a/02.png' }, { file: 'a/03.png' }];
  const added = notesLib.addNote({ actionsDir, actionId: 'walk-left', frame: 1, file: frames[1].file, severity: 'fix', text: '02 的裙摆被裁了一点', now: () => '2026-09-27T00:00:00.000Z' });
  assert.equal(added.ok, true);
  assert.equal(added.note.id, 'n-001');
  assert.equal(fs.existsSync(path.join(actionsDir, 'walk-left.notes.json')), true, 'notes live in a sidecar, not in the action doc');

  const listed = notesLib.listNotes({ actionsDir, actionId: 'walk-left', frames });
  assert.equal(listed.notes.length, 1);
  assert.equal(listed.open, 1);
  assert.equal(listed.stale, 0);

  // reorder the frames underneath the note: the note must be flagged, not silently repointed
  const reordered = [frames[0], frames[2], frames[1]];
  const afterReorder = notesLib.listNotes({ actionsDir, actionId: 'walk-left', frames: reordered });
  assert.equal(afterReorder.stale, 1, 'a note whose frame file moved is flagged stale');
  assert.equal(afterReorder.notes[0].currentFile, 'a/03.png');

  notesLib.resolveNote({ actionsDir, actionId: 'walk-left', noteId: 'n-001', resolved: true });
  assert.equal(notesLib.listNotes({ actionsDir, actionId: 'walk-left', frames }).open, 0);

  const exported = notesLib.exportNotes({ actionsDir, actionId: 'walk-left', frames, summary: { id: 'walk-left', frames: frames.length } });
  assert.equal(exported.ok, true);
  assert.equal(exported.frames.length, 3, 'the export carries the frame mapping the notes refer to');
  assert.equal(exported.notes[0].text, '02 的裙摆被裁了一点');
  const round = JSON.parse(JSON.stringify(exported));
  assert.equal(round.notes[0].frame, 1, 'the annotation is anchored to a frame INDEX');
});

test('bad notes are refused with stable codes', (t) => {
  const dir = sandbox(t);
  const actionsDir = path.join(dir, 'actions');
  assert.equal(notesLib.addNote({ actionsDir, actionId: 'x', frame: -1, text: 'x' }).code, 'NOTE_FRAME_INVALID');
  assert.equal(notesLib.addNote({ actionsDir, actionId: 'x', frame: 0, text: '   ' }).code, 'NOTE_TEXT_REQUIRED');
  assert.equal(notesLib.addNote({ actionsDir, actionId: 'x', frame: 0, text: 'x', severity: 'urgent' }).code, 'NOTE_SEVERITY_INVALID');
});

test('the capability gap report reads the real inventory and names the missing ones', () => {
  const gaps = realServices().gapReport();
  assert.equal(gaps.ok, true, `no required capability is missing (${JSON.stringify(gaps.requiredGaps)})`);
  const byId = new Map(gaps.capabilities.map((row) => [row.id, row]));
  for (const id of ['idle', 'walk-all-directions', 'working-back', 'outcome']) {
    assert.equal(byId.get(id).status, 'complete', `${id} is covered`);
  }
  // the two honest gaps: a dedicated turn animation and talking frames
  assert.deepEqual(gaps.optionalGaps.filter((id) => ['turn', 'talk'].includes(id)).sort(), ['talk', 'turn']);
  for (const id of ['turn', 'talk']) {
    const row = byId.get(id);
    assert.equal(row.status, 'not-produced');
    assert.match(row.how, /尚未产出/, `${id} explains how to add it`);
  }
  // a required gap really does fail the report (synthetic inventory)
  const broken = require(path.join(STUDIO_ROOT, 'lib', 'actions', 'gaps.js')).capabilityReport({ actionIds: ['idle'] });
  assert.equal(broken.ok, false);
  assert.ok(broken.requiredGaps.includes('walk-all-directions'));
});

test('REAL ACCEPTANCE 审片→改→发布: migrate to v2, annotate, publish, and the pack still validates', (t) => {
  const project = sandboxProject(t);
  const { services, charactersRoot } = project;

  // 1) REVIEW: the bench view of a real action
  const before = services.show('walk-left');
  assert.equal(before.ok, true);
  assert.equal(before.summary.frames, 15);
  assert.equal(before.runtime.inSync, true);

  // 2) CHANGE: v1 → v2 across the whole character, then author v2 richness
  // the sandbox copy is already v2 (the real docs were migrated): migration is a no-op,
  // which is the property to hold; a v1 doc is exercised separately below
  const migration = services.migrateAll();
  assert.deepEqual(migration.migrated, [], 'already-v2 docs are not rewritten');
  assert.equal(migration.skipped.filter((entry) => entry.code === 'ALREADY_V2').length, 8, 'all eight report ALREADY_V2');
  const docFile = path.join(services.actionsDir, 'walk-left.json');
  const doc = JSON.parse(fs.readFileSync(docFile, 'utf8'));
  assert.equal(doc.schemaVersion, 2);
  doc.tags = ['walk', 'highlight'];
  doc.events = [{ frame: 3, name: 'footstep' }];
  doc.frames[0].durationMs = 120;
  fs.writeFileSync(docFile, `${JSON.stringify(doc, null, 2)}\n`);

  const noted = services.addNote({ actionId: 'walk-left', frame: 0, file: doc.frames[0].file, severity: 'note', text: '首帧节奏放慢到 120ms，看下过渡' });
  assert.equal(noted.ok, true);

  const after = services.show('walk-left');
  assert.deepEqual(after.doc.tags, ['walk', 'highlight']);
  assert.equal(after.doc.events[0].frame, 3);
  assert.equal(after.runtime.inSync, false, 'the edited doc differs from the pack until it is published');
  assert.deepEqual(after.runtime.dropped, [], 'metadata is no longer dropped — it travels to the pack');
  assert.equal(after.notes.length, 1);

  // 3) PUBLISH through the real kernel (writes the sandbox pack + provenance)
  const published = services.publish('walk-left');
  assert.equal(published.ok, true, `publish succeeded (${published.code || ''} ${JSON.stringify(published.violations || [])})`);
  assert.equal(published.summary.rewritten.includes('animation/animations.json'), true);
  assert.deepEqual(published.runtime.dropped, [], 'the publish drops nothing (widened contract)');

  const packAnimations = JSON.parse(fs.readFileSync(path.join(charactersRoot, PACK_ID, 'animation', 'animations.json'), 'utf8'));
  const entry = packAnimations.animations['walk-left'];
  assert.deepEqual(Object.keys(entry).sort(), ['direction', 'events', 'frames', 'loop', 'state', 'tags'], 'the pack entry carries the runtime fields AND the v2 metadata');
  assert.equal(entry.frames[0].durationMs, 120, 'the edited duration landed in the pack');
  assert.equal(entry.frames.length, 15, 'all frames survived the compile-down');
  assert.deepEqual(entry.tags, ['walk', 'highlight'], 'the tags travel (P3 follow-up)');
  assert.deepEqual(entry.events, [{ frame: 3, name: 'footstep' }], 'the events travel');

  // 4) the STRICT production validator accepts the published pack
  const validatorPath = path.join(REPO_ROOT, 'scripts', 'office-assets', 'validate-character-pack.js');
  const outcome = execFileSync(process.execPath, ['-e', `
    const { validateCharacterPack } = require(${JSON.stringify(validatorPath)});
    const result = validateCharacterPack(${JSON.stringify(path.join(charactersRoot, PACK_ID))});
    console.log(JSON.stringify({ ok: result.ok, failures: result.failures || [], warnings: (result.warnings || []).length }));
  `], { encoding: 'utf8' });
  const validated = JSON.parse(outcome.trim().split('\n').pop());
  assert.equal(validated.ok, true, `the published pack passes the production validator (${JSON.stringify(validated.failures)})`);

  // 5) the provenance ledger records the publish (so the passport can prove it)
  const provenanceDir = path.join(services.paths.provenanceDir);
  const records = fs.readdirSync(provenanceDir).filter((name) => name.endsWith('walk-left.json'));
  assert.ok(records.length >= 2, `publish records accumulate (${records.length})`);

  // 6) and the notes exported for the reviewer carry the anchor + the frame map
  const exported = services.exportNotes('walk-left');
  assert.equal(exported.notes.length, 1);
  assert.equal(exported.frames[0].durationMs, 120, 'the export reflects the edited timing');
});
