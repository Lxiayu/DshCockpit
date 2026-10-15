'use strict';

// src/workbench/test/action-restore.test.js — the 动作 page's undo replay, at the
// transaction level (workbench UX rectification, gap #1: 撤销/重做).
//
// The action ops autosave to disk (m1ActionOp → model.saveActionDoc), so undoing
// an action edit is a WRITE. This test drives the real service on a sandbox copy
// of the character tree and pins the rules that make that safe:
//   * restore puts a whole-document snapshot back, byte-for-byte what the op wrote;
//   * an identical snapshot does not rewrite the file (无变更不记录);
//   * a snapshot belonging to another action, or one the model cannot parse, is
//     REFUSED and leaves the file untouched — the undo replays through the same
//     validation as any other op, never around it.
// Run with:  node --test "src/workbench/test/*.test.js"

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const { m1ActionOp } = require(path.join(REPO_ROOT, 'src', 'workbench', 'app', 'services.js'));
const model = require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'action-model.js'));
const publisher = require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'action-publisher.js'));

const ACTION_ID = 'walk-left';

// A sandbox with the real character project, so the action ops run against real
// paths and real frame references without touching the repository.
function sandboxCtx(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-restore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const contentDir = path.join(dir, 'content');
  const charactersRoot = path.join(dir, 'resources', 'characters');
  fs.mkdirSync(charactersRoot, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'content', 'characters'), path.join(contentDir, 'characters'), { recursive: true });
  return {
    dir,
    contentDir,
    charactersRoot,
    ctx: { contentDir, charactersRoot, characterId: 'whale-girl', scheme: 'workbench', libs: { model, publisher } },
  };
}

const docPath = (ctx) => path.join(ctx.contentDir, 'characters', 'whale-girl', 'actions', `${ACTION_ID}.json`);
const readDoc = (ctx) => JSON.parse(fs.readFileSync(docPath(ctx), 'utf8'));

test('an action edit is undone by restoring the whole-document snapshot', (t) => {
  const { ctx } = sandboxCtx(t);
  const before = readDoc(ctx);

  const moved = m1ActionOp(ctx, ACTION_ID, 'move', { from: 0, to: 2 });
  assert.equal(moved.ok, true, `the move ran (${moved.code || ''})`);
  assert.equal(moved.changed, true);
  const movedFrames = readDoc(ctx).frames.map((frame) => frame.file);
  assert.notDeepEqual(movedFrames, before.frames.map((frame) => frame.file), 'the move really reordered the document');

  const undone = m1ActionOp(ctx, ACTION_ID, 'restore', { doc: before });
  assert.equal(undone.ok, true, `the restore ran (${undone.code || ''})`);
  assert.equal(undone.changed, true);
  assert.deepEqual(readDoc(ctx), before, 'the document is exactly what it was before the move');
  // the same writer the ops use, so the bytes are the model's canonical serialization
  assert.equal(fs.readFileSync(docPath(ctx)).toString(), `${JSON.stringify(before, null, 2)}\n`);
});

test('redo restores the edited snapshot again (the stack replays both directions)', (t) => {
  const { ctx } = sandboxCtx(t);
  const before = readDoc(ctx);
  const moved = m1ActionOp(ctx, ACTION_ID, 'move', { from: 0, to: 2 });
  const after = readDoc(ctx);

  const undone = m1ActionOp(ctx, ACTION_ID, 'restore', { doc: before });
  assert.equal(undone.ok, true);
  const redone = m1ActionOp(ctx, ACTION_ID, 'restore', { doc: after });
  assert.equal(redone.ok, true);
  assert.deepEqual(readDoc(ctx), after, 'the redone document is the edited one');
  assert.equal(moved.changed, true);
});

test('an identical snapshot does not rewrite the draft (无变更不记录)', (t) => {
  const { ctx } = sandboxCtx(t);
  const before = readDoc(ctx);
  const bytes = fs.readFileSync(docPath(ctx));
  const outcome = m1ActionOp(ctx, ACTION_ID, 'restore', { doc: before });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.changed, false);
  assert.ok(fs.readFileSync(docPath(ctx)).equals(bytes), 'the file is untouched when nothing changes');
});

test('a snapshot from another action is refused, and the file stays put', (t) => {
  const { ctx } = sandboxCtx(t);
  const before = readDoc(ctx);
  const bytes = fs.readFileSync(docPath(ctx));
  const foreign = { ...before, id: 'walk-right' };
  const outcome = m1ActionOp(ctx, ACTION_ID, 'restore', { doc: foreign });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'ACTION_RESTORE_MISMATCH');
  assert.ok(fs.readFileSync(docPath(ctx)).equals(bytes), 'a foreign snapshot never lands');
});

test('a snapshot the model cannot parse is refused, and the file stays put', (t) => {
  const { ctx } = sandboxCtx(t);
  const before = readDoc(ctx);
  const bytes = fs.readFileSync(docPath(ctx));
  const broken = { ...before, frames: 'not-an-array' };
  const outcome = m1ActionOp(ctx, ACTION_ID, 'restore', { doc: broken });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'ACTION_SCHEMA_INVALID');
  assert.ok(fs.readFileSync(docPath(ctx)).equals(bytes), 'an invalid snapshot never lands');
  // and a non-document payload is refused before it reaches the model
  const nonsense = m1ActionOp(ctx, ACTION_ID, 'restore', { doc: null });
  assert.equal(nonsense.ok, false);
  assert.equal(nonsense.code, 'ACTION_RESTORE_INVALID');
});

test('the duration and loop edits round-trip through the same replay', (t) => {
  const { ctx } = sandboxCtx(t);
  const before = readDoc(ctx);
  const duration = m1ActionOp(ctx, ACTION_ID, 'duration', { index: 0, value: 1234 });
  assert.equal(duration.changed, true);
  assert.equal(readDoc(ctx).frames[0].durationMs, 1234);
  const loop = m1ActionOp(ctx, ACTION_ID, 'loop', { value: !before.loop });
  assert.equal(loop.changed, true);
  const undone = m1ActionOp(ctx, ACTION_ID, 'restore', { doc: before });
  assert.equal(undone.ok, true);
  assert.deepEqual(readDoc(ctx), before, 'one snapshot replays a run of different ops');
});
