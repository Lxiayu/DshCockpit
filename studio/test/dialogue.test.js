'use strict';

// studio/test/dialogue.test.js — the dialogue corpus engine (P7).
//
// The guards are the point: a corpus fails quietly (a repeated line, a placeholder no
// scope provides, a path or a run id leaking into a bubble), so every class is asserted
// against a sandbox copy of the REAL two-layer corpus, and the save path is held to the
// same discipline as the other editors (red ⇒ refused + byte-identical file, else byte
// backup, unchanged ⇒ no-op).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
const CONTENT_ROOT = path.join(REPO_ROOT, 'content');

const corpus = require(path.join(STUDIO_ROOT, 'lib', 'dialogue', 'corpus.js'));

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dialogue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const contentDir = path.join(dir, 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.cpSync(path.join(CONTENT_ROOT, 'shared'), path.join(contentDir, 'shared'), { recursive: true });
  fs.cpSync(path.join(CONTENT_ROOT, 'characters'), path.join(contentDir, 'characters'), { recursive: true });
  return { contentDir, dir };
}

const baseBoth = () => ({
  base: corpus.read({ contentDir: CONTENT_ROOT, layer: 'base' }).doc,
  character: corpus.read({ contentDir: CONTENT_ROOT, layer: 'character' }).doc,
});

test('the real two-layer corpus passes the guards, with only informative yellows', () => {
  const { base, character } = baseBoth();
  const outcome = corpus.validateCorpus({ base, character });
  assert.equal(outcome.ok, true, `no red findings (${JSON.stringify(outcome.findings.filter((finding) => finding.severity === 'red'))})`);
  assert.equal(outcome.stats.base.entries, 19);
  assert.equal(outcome.stats.character.entries, 10);
  const codes = outcome.findings.map((finding) => finding.code);
  // both yellows are real observations about the shipped corpus, not noise
  assert.ok(codes.includes('corpus.if-unknown-key'), 'if.nearProp is flagged as an unknown condition');
  assert.ok(codes.includes('corpus.override-only-topic'), 'character/idle has no base topic to fall back to');
  for (const finding of outcome.findings) assert.ok(finding.fix, `${finding.code} carries a fix`);
});

test('the guards catch every failure class the corpus can hide', () => {
  const cases = [
    [{ id: 'x-1', text: '嗨' }, { id: 'x-1', text: '嘿' }, 'corpus.entry-id-duplicate'],
    [{ id: 'x-1', text: '嗨' }, { id: 'x-2', text: '嗨' }, 'corpus.text-duplicate'],
    [{ id: 'x-1', text: '   ' }, null, 'corpus.entry-text'],
    [{ id: 'x-1', text: '嗨', weight: 0 }, null, 'corpus.weight'],
    [{ id: 'x-1', text: '嗨', weight: 2.5 }, null, 'corpus.weight'],
    [{ id: 'BAD_ID', text: '嗨' }, null, 'corpus.entry-id'],
    [{ id: 'x-1', text: '进度 {percent}%' }, null, 'corpus.placeholder-unknown'],
    [{ id: 'x-1', text: '嗨', if: { nearProp: true } }, null, 'corpus.if-unknown-key'],
    [{ id: 'x-1', text: '会话 session_9f3a2b1c 出错了' }, null, 'corpus.text-identifier'],
    [{ id: 'x-1', text: '文件在 /Users/xia/program 里' }, null, 'corpus.text-path'],
    [{ id: 'x-1', text: `token=${'a'.repeat(24)}` }, null, 'corpus.text-secret-shape'],
    [{ id: 'x-1', text: '嗨'.repeat(70) }, null, 'corpus.text-long'],
  ];
  for (const [first, second, expected] of cases) {
    const base = { schemaVersion: 1, topics: { probe: second ? [first, second] : [first] } };
    const outcome = corpus.validateCorpus({ base });
    const codes = outcome.findings.map((finding) => finding.code);
    assert.ok(codes.includes(expected), `${expected} is reported (got ${codes.join(',')})`);
    const finding = outcome.findings.find((entry) => entry.code === expected);
    assert.ok(finding.fix, `${expected} has a fix`);
    if (expected === 'corpus.text-long' || expected === 'corpus.if-unknown-key' || expected === 'corpus.placeholder-unknown' || expected === 'corpus.text-duplicate') {
      assert.equal(finding.severity, 'yellow', `${expected} is a review note`);
    } else {
      assert.equal(finding.severity, 'red', `${expected} blocks the save`);
    }
  }
});

test('the character layer wins per topic, and the base stays as the fallback', () => {
  const { base, character } = baseBoth();
  const overridden = corpus.resolveTopic({ base, character, topic: 'greeting' });
  assert.equal(overridden.source, 'character');
  assert.equal(overridden.entries.length, 2);
  assert.ok(overridden.fallback && overridden.fallback.length === 4, 'the base greeting survives as fallback');
  const baseOnly = corpus.resolveTopic({ base, character, topic: 'pantry' });
  assert.equal(baseOnly.source, 'base');
  assert.equal(baseOnly.fallback, null);
  const characterOnly = corpus.resolveTopic({ base, character, topic: 'idle' });
  assert.equal(characterOnly.source, 'character', 'a topic only the character defines resolves to the character layer');
  const unknown = corpus.resolveTopic({ base, character, topic: 'nope' });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.known.includes('greeting'));
});

test('picking a line is seeded, respects weights and honours conditions', () => {
  const entries = [
    { id: 'a', text: '甲', weight: 1 },
    { id: 'b', text: '乙', weight: 9 },
    { id: 'c', text: '丙', weight: 1, if: { timeOfDay: 'night' } },
  ];
  const first = corpus.pickEntry({ entries, seed: 'fixed' });
  const again = corpus.pickEntry({ entries, seed: 'fixed' });
  assert.deepEqual(first.entry, again.entry, 'same seed ⇒ same line');
  assert.notEqual(corpus.pickEntry({ entries, seed: 'other' }).entry.id, undefined);
  // daytime: the conditional entry is out of the pool
  const day = corpus.pickEntry({ entries, seed: 's', context: { timeOfDay: 'day' } });
  assert.equal(day.eligible, 2);
  assert.notEqual(day.entry.id, 'c');
  // night: it is back in
  const night = corpus.pickEntry({ entries, seed: 's', context: { timeOfDay: 'night' } });
  assert.equal(night.eligible, 3);
  // the heavy weight dominates over many draws
  const draws = Array.from({ length: 60 }, (_, index) => corpus.pickEntry({ entries, seed: `s-${index}` }).entry.id);
  const heavy = draws.filter((id) => id === 'b').length;
  assert.ok(heavy > draws.length / 2, `the weight-9 line dominates (${heavy}/${draws.length})`);
});

test('CSV import handles quotes, optional columns and refuses malformed input', () => {
  const parsed = corpus.parseCsv('id,topic,text,weight,if.timeOfDay\nc-1,pantry,"说, 这个米饭",3,morning\nc-2,pantry,碗空了,1\n');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].entry.text, '说, 这个米饭', 'a quoted comma survives');
  assert.equal(parsed.rows[0].entry.weight, 3);
  assert.deepEqual(parsed.rows[0].entry.if, { timeOfDay: 'morning' });

  assert.equal(corpus.parseCsv('id,topic\n1,x\n').code, 'CSV_NO_TEXT_COLUMN');
  assert.equal(corpus.parseCsv('id,text\n1,\n').ok, false, 'a row without text is refused');
  assert.equal(corpus.parseCsv('').code, 'CSV_EMPTY');

  const { base } = baseBoth();
  const merged = corpus.importRows({ doc: base, layer: 'base', rows: parsed.rows });
  assert.equal(merged.added.length, 2);
  assert.equal(merged.doc.topics.pantry.length, base.topics.pantry.length + 2, 'the imported rows joined the existing topic');
  assert.ok(merged.doc.topics.pantry.some((entry) => entry.text === '说, 这个米饭'));
});

test('editing stages on a copy: add, update, remove never touch the loaded document', () => {
  const { base } = baseBoth();
  const snapshot = JSON.stringify(base);
  const added = corpus.addEntry({ doc: base, layer: 'base', topic: 'pantry', entry: { id: 'zz-1', text: '新台词', weight: 2 } });
  assert.equal(added.ok, true);
  assert.notEqual(added.doc, base, 'the edit returns a new document');
  assert.equal(JSON.stringify(base), snapshot, 'the input document is untouched');
  assert.equal(corpus.addEntry({ doc: base, layer: 'base', topic: 'pantry', entry: { id: 'g-01', text: '重复 id' } }).code, 'CORPUS_ID_TAKEN');
  const updated = corpus.updateEntry({ doc: base, layer: 'base', topic: 'pantry', id: 'p-01', patch: { text: '改过的台词' } });
  assert.equal(updated.ok, true);
  assert.equal(updated.entry.text, '改过的台词');
  const removed = corpus.removeEntry({ doc: base, layer: 'base', topic: 'pantry', id: 'p-01' });
  assert.equal(removed.ok, true);
  assert.equal(removed.doc.topics.pantry.length, base.topics.pantry.length - 1);
  assert.equal(corpus.removeEntry({ doc: base, layer: 'base', topic: 'pantry', id: 'ghost' }).code, 'CORPUS_ENTRY_UNKNOWN');
});

test('saving refuses red findings byte-identically, and otherwise backs the file up', (t) => {
  const { contentDir } = sandbox(t);
  const loaded = corpus.read({ contentDir, layer: 'base' });
  assert.equal(loaded.ok, true);
  const file = loaded.file;
  const before = fs.readFileSync(file, 'utf8');

  // 1) a red line (a run id in a bubble) is refused and writes nothing
  const withBadLine = corpus.addEntry({ doc: loaded.doc, layer: 'base', topic: 'pantry', entry: { id: 'zz-bad', text: 'run_abcdef123456 挂了', weight: 1 } });
  assert.equal(withBadLine.ok, true, 'staging is allowed; the guard runs at save time');
  const refused = corpus.save({ contentDir, characterId: 'whale-girl', layer: 'base', doc: withBadLine.doc, dryRun: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'CORPUS_INVALID');
  assert.ok(refused.findings.some((finding) => finding.code === 'corpus.text-identifier'));
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused save leaves the file byte-identical');

  // 2) a clean line saves, with a byte-copy backup of the previous file
  const withGoodLine = corpus.addEntry({ doc: loaded.doc, layer: 'base', topic: 'pantry', entry: { id: 'zz-good', text: '米缸还有半缸', weight: 2 } });
  const saved = corpus.save({ contentDir, characterId: 'whale-girl', layer: 'base', doc: withGoodLine.doc, dryRun: false });
  assert.equal(saved.ok, true, `save ok (${saved.code || ''} ${JSON.stringify((saved.findings || []).slice(0, 2))})`);
  assert.ok(saved.backup && fs.existsSync(saved.backup), 'the previous file is backed up');
  assert.equal(fs.readFileSync(saved.backup, 'utf8'), before, 'the backup is the untouched original');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(after.topics.pantry.some((entry) => entry.text === '米缸还有半缸'), 'the line landed');
  assert.equal(after.topics.greeting.length, loaded.doc.topics.greeting.length, 'other topics are untouched');

  // 3) saving the same document again is a no-op
  const again = corpus.save({ contentDir, characterId: 'whale-girl', layer: 'base', doc: after, dryRun: false });
  assert.equal(again.noop, true, '无变更不落盘');
});

test('the corpus files the runtime reads are the ones the studio edits', () => {
  // the two layers live exactly where the dialogue engine loads them from
  assert.equal(path.relative(REPO_ROOT, corpus.fileFor({ contentDir: CONTENT_ROOT, layer: 'base' })), 'content/shared/dialogue/base.json');
  assert.equal(path.relative(REPO_ROOT, corpus.fileFor({ contentDir: CONTENT_ROOT, characterId: 'whale-girl', layer: 'character' })), 'content/characters/whale-girl/dialogue/character.json');
  // and the publication copy the runtime ships is byte-identical to the content tree
  for (const [source, published] of [
    [path.join(CONTENT_ROOT, 'shared', 'dialogue', 'base.json'), path.join(REPO_ROOT, 'resources', 'dialogue', 'base.json')],
    [path.join(CONTENT_ROOT, 'characters', 'whale-girl', 'dialogue', 'character.json'), path.join(REPO_ROOT, 'resources', 'dialogue', 'characters', 'deepseek-default.json')],
  ]) {
    assert.equal(fs.readFileSync(source).equals(fs.readFileSync(published)), true, `${path.relative(REPO_ROOT, published)} mirrors the content tree`);
  }
});
