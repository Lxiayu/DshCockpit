'use strict';

// studio/test/history.test.js — the undo/redo stack of the workbench shell.
//
// The stack is the only thing between a mis-dragged chair and "reload and lose
// the draft", and it is pure on purpose (no DOM, no IPC, no file system), so
// what is tested here IS the whole module:
//   * a push/undo/redo round trip hands back the SAME opaque values (the module
//     files references, it never clones — the caller owns the snapshots);
//   * running past either end returns the documented code, never a throw;
//   * a new step after an undo clears the redo branch (standard semantics);
//   * the cap drops the OLDEST entries and size() reports it;
//   * peek() orders the lists the way a menu renders them;
//   * nothing the module returns shares mutable state with the inside of the
//     stack, and two histories never share state with each other.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const {
  createHistory,
  HISTORY_LIMIT_DEFAULT,
} = require(path.join(REPO_ROOT, 'src', 'workbench', 'app', 'history.js'));

test('a push/undo/redo round trip returns the same opaque values', (t) => {
  const history = createHistory();
  const before = { draft: 'v1', items: ['desk'] };
  const after = { draft: 'v2', items: ['desk', 'rice-cooker'] };
  const id = history.push({ label: '拖入电饭煲', before, after, meta: { page: 'scene' } });

  assert.equal(id, 1, 'push returns the monotonic id of the new entry (ids start at 1)');
  assert.equal(history.canUndo(), true, 'one step is undoable');
  assert.equal(history.canRedo(), false, 'nothing is redoable before an undo');

  const undone = history.undo();
  assert.equal(undone.ok, true, `undo ok (${undone.code || ''})`);
  assert.equal(undone.entry.id, id, 'the entry names itself by the id push returned');
  assert.equal(undone.entry.label, '拖入电饭煲', 'the label survives for the menu');
  assert.deepEqual(undone.entry.meta, { page: 'scene' }, 'meta travels with the entry');
  assert.equal(undone.entry.before, before, 'the caller re-applies entry.before');
  assert.equal(undone.entry.after, after);

  const redone = history.redo();
  assert.equal(redone.ok, true, `redo ok (${redone.code || ''})`);
  assert.equal(redone.entry.id, id, 'the same step comes back, not a copy of its history');
  assert.equal(redone.entry.after, after, 'the caller re-applies entry.after');
  assert.deepEqual(history.size(), { undo: 1, redo: 0, limit: HISTORY_LIMIT_DEFAULT }, 'redo restores the stack exactly');
});

test('undo/redo past the ends yield the documented codes, not throws', (t) => {
  const history = createHistory();
  assert.deepEqual(history.undo(), { ok: false, code: 'HISTORY_EMPTY' }, 'a fresh stack refuses to undo without throwing');
  assert.deepEqual(history.redo(), { ok: false, code: 'HISTORY_NO_REDO' }, 'a fresh stack refuses to redo without throwing');

  history.push({ label: 'move', before: {}, after: {} });
  history.undo();
  assert.equal(history.canRedo(), true, 'the undone step is redoable');
  history.undo();
  assert.equal(history.canUndo(), false, 'the undo stack ran out of steps');

  const failedUndo = history.undo();
  assert.deepEqual(failedUndo, { ok: false, code: 'HISTORY_EMPTY' }, 'undoing past the oldest step');
  assert.equal('entry' in failedUndo, false, 'a failed undo hands back no half result');

  assert.equal(history.redo().entry.label, 'move', 'a failed undo is inert: the redo branch survived it');
  const failedRedo = history.redo();
  assert.deepEqual(failedRedo, { ok: false, code: 'HISTORY_NO_REDO' }, 'redoing past the newest step');
  assert.equal(history.undo().entry.label, 'move', 'a failed redo is inert too: the step is still undoable');
});

test('pushing after an undo clears the redo branch', (t) => {
  const history = createHistory();
  const aAfter = { label: 'a-after' };
  history.push({ label: 'a', before: { label: 'a-before' }, after: aAfter });
  history.push({ label: 'b', before: { label: 'b-before' }, after: { label: 'b-after' } });

  history.undo();
  assert.equal(history.canRedo(), true, 'an undone step is waiting to be redone');

  const cBefore = { label: 'c-before' };
  const cAfter = { label: 'c-after' };
  const id = history.push({ label: 'c', before: cBefore, after: cAfter });

  assert.equal(history.canRedo(), false, 'a new step rewrites the future: the redo branch is gone');
  assert.equal(history.size().redo, 0, 'size() agrees');
  assert.deepEqual(history.redo(), { ok: false, code: 'HISTORY_NO_REDO' }, 'the old branch cannot be reached any more');

  const undone = history.undo();
  assert.equal(undone.entry.id, id, 'the newest step is the one undo reverts');
  assert.equal(undone.entry.before, cBefore, 'undo reverts the new step, not the abandoned one');
  assert.equal(undone.entry.after, cAfter);
});

test('the limit drops the OLDEST entry and size() reports it', (t) => {
  const history = createHistory({ limit: 2 });
  assert.equal(history.size().limit, 2, 'the cap is the one the caller asked for');

  const snapshots = [];
  for (let step = 1; step <= 4; step += 1) {
    const snapshot = { step };
    snapshots.push(snapshot);
    history.push({ label: `step ${step}`, before: snapshot, after: snapshot });
  }

  assert.deepEqual(history.size(), { undo: 2, redo: 0, limit: 2 }, 'only the cap many steps survive');
  assert.deepEqual(history.peek().undo.map((entry) => entry.label), ['step 4', 'step 3'], 'the oldest snapshots were dropped, not the newest');

  history.undo();
  assert.equal(history.undo().entry.before, snapshots[2], 'the oldest surviving step is step 3');
  assert.deepEqual(history.undo(), { ok: false, code: 'HISTORY_EMPTY' }, 'nothing older than the cap is reachable');
});

test('peek() lists the undo steps newest-first and the redo steps oldest-first', (t) => {
  const history = createHistory();
  const labels = ['拖入电饭煲', '拖动椅子', '删除台灯'];
  for (const label of labels) {
    const snapshot = { label };
    history.push({ label, before: snapshot, after: snapshot });
  }

  assert.deepEqual(history.peek().undo.map((entry) => entry.label), ['删除台灯', '拖动椅子', '拖入电饭煲'],
    'the undo list is newest-first: the first line is what ⌘Z reverts next');
  assert.deepEqual(history.peek().redo, [], 'nothing is redoable before an undo');

  history.undo(); // reverts 删除台灯
  history.undo(); // reverts 拖动椅子

  assert.deepEqual(history.peek().undo.map((entry) => entry.label), ['拖入电饭煲'], 'the remaining undoable step is on top');
  assert.deepEqual(history.peek().redo.map((entry) => entry.label), ['拖动椅子', '删除台灯'],
    'the redo list is oldest-first: the first line is what ⇧⌘Z applies next');

  // The menu gets a label, not a snapshot: peek() never hands out the payload.
  const [top] = history.peek().undo;
  assert.deepEqual(top, { id: 1, label: '拖入电饭煲', meta: null }, 'a peeked line is a summary entry');
  assert.notEqual(history.peek(), history.peek(), 'every peek() is a fresh object');
});

test('purity: the module neither clones nor mutates the caller\'s snapshots', (t) => {
  const history = createHistory();
  const before = { items: ['desk'] };
  const after = { items: ['desk', 'rice-cooker'] };
  const step = { label: '拖入电饭煲', before, after, meta: { page: 'scene' } };
  const pristine = structuredClone(step);

  history.push(step);
  assert.deepEqual(step, pristine, 'push does not touch the object it was handed');

  const undone = history.undo();
  assert.equal(undone.entry.before, before, 'before is the very object the caller passed');
  assert.equal(undone.entry.after, after, 'after is the very object the caller passed');
  assert.equal(undone.entry.meta, step.meta, 'meta comes back by reference too');

  // Stored by reference, never copied: what the caller mutates afterwards is what
  // the replay will see — which is exactly why the caller must hand in a clone.
  after.items.push('plant');
  assert.equal(history.redo().entry.after, after);
  const again = history.undo();
  assert.equal(again.entry.after.items.length, 3, 'the stack holds a reference, not a snapshot of a snapshot');

  // And nothing that leaks out reaches back into the stack.
  again.entry.label = 'tampered';
  again.entry.before = null;
  history.redo();
  assert.equal(history.peek().undo[0].label, '拖入电饭煲', 'a returned entry is a copy, not the stored one');
  assert.equal(history.undo().entry.before, before, 'the stored step survived the tampering');
});

test('a redo is consumed exactly once', (t) => {
  const history = createHistory();
  const before = { v: 0 };
  const after = { v: 1 };
  history.push({ label: 'bump', before, after });

  assert.equal(history.undo().entry.before, before, 'undo reverts to the recorded before');
  const first = history.redo();
  assert.equal(first.ok, true);
  assert.equal(first.entry.after, after, 'redo re-applies the recorded after');
  assert.equal(history.canRedo(), false, 'the redo branch is now empty');

  assert.deepEqual(history.redo(), { ok: false, code: 'HISTORY_NO_REDO' }, 'a second redo in a row has nothing left');
  assert.equal(history.canUndo(), true, 'the step is undoable again');
  assert.equal(history.undo().entry.after, after);
});

test('clear() empties both directions', (t) => {
  const history = createHistory();
  history.push({ label: 'a', before: {}, after: {} });
  history.push({ label: 'b', before: {}, after: {} });
  history.undo();
  assert.equal(history.canUndo(), true, 'one step is undoable');
  assert.equal(history.canRedo(), true, 'one step is redoable');

  history.clear();

  assert.deepEqual(history.size(), { undo: 0, redo: 0, limit: HISTORY_LIMIT_DEFAULT }, 'both stacks read empty');
  assert.deepEqual(history.peek(), { undo: [], redo: [] }, 'the menus have nothing to show');
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
  assert.deepEqual(history.undo(), { ok: false, code: 'HISTORY_EMPTY' });
  assert.deepEqual(history.redo(), { ok: false, code: 'HISTORY_NO_REDO' });
});

test('the documented surface, the default limit, and the zero cap', (t) => {
  assert.equal(HISTORY_LIMIT_DEFAULT, 50, 'the plan\'s "≤50 份无压力" cap is the default');
  assert.equal(createHistory().size().limit, HISTORY_LIMIT_DEFAULT, 'createHistory() works with no argument');
  assert.equal(createHistory({}).size().limit, HISTORY_LIMIT_DEFAULT);
  assert.equal(createHistory({ limit: null }).size().limit, HISTORY_LIMIT_DEFAULT, 'null means "no opinion"');

  for (const name of ['push', 'undo', 'redo', 'canUndo', 'canRedo', 'peek', 'clear', 'size']) {
    assert.equal(typeof createHistory()[name], 'function', `${name}() is part of the API`);
  }

  const mute = createHistory({ limit: 0 });
  mute.push({ label: 'lost', before: {}, after: {} });
  assert.deepEqual(mute.size(), { undo: 0, redo: 0, limit: 0 }, 'a zero cap keeps no history at all');
  assert.equal(mute.canUndo(), false, 'undo is permanently empty');
  assert.deepEqual(mute.undo(), { ok: false, code: 'HISTORY_EMPTY' });
});

test('ids are monotonic per instance, and instances share no state', (t) => {
  const first = createHistory();
  const second = createHistory();

  assert.equal(first.push({ label: 'one', before: {}, after: {} }), 1, 'ids start at 1');
  first.clear();
  assert.equal(first.push({ label: 'two', before: {}, after: {} }), 2, 'a cleared stack never re-issues an id a UI already showed');

  assert.equal(second.canUndo(), false, 'no module-level state: the other history saw nothing');
  assert.equal(second.peek().undo.length, 0);
  assert.deepEqual(second.size(), { undo: 0, redo: 0, limit: HISTORY_LIMIT_DEFAULT });
  assert.deepEqual(second.undo(), { ok: false, code: 'HISTORY_EMPTY' });
});

test('a nonsense cap or step is a programming error, not silent misbehaviour', (t) => {
  assert.throws(() => createHistory({ limit: -1 }), TypeError, 'a negative cap makes no sense');
  assert.throws(() => createHistory({ limit: 2.5 }), TypeError, 'a fractional cap makes no sense');
  assert.throws(() => createHistory({ limit: 'many' }), TypeError, 'a non-numeric cap makes no sense');
  assert.throws(() => createHistory().push(null), TypeError, 'push needs an object');
  assert.throws(() => createHistory().push('拖入电饭煲'), TypeError, 'push needs an object');
});
