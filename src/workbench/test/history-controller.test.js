'use strict';

// src/workbench/test/history-controller.test.js — the shared undo/redo dispatcher
// (workbench UX rectification, gap #1: 撤销/重做).
//
// WHY these live here and not in studio/test/: this round's file scope is
// src/workbench/** only (the studio suite belongs to another change), and the
// controller is a pure dual module — the same require()-able-from-Node pattern
// app/history.js already established. Run with:
//   node --test src/workbench/test/
//
// The acceptance the rectification asked for is "改 → ⌘Z → 断言回到前值 → ⇧⌘Z →
// 断言再前进", so the first test drives exactly that sequence through a page
// restorer that mutates a document, and the rest pin the safety rules: a step is
// never consumed by a page that cannot replay it, a new edit clears the redo
// branch, and the summary the top bar reads is the stack's own truth.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHistory } = require('../app/history.js');
const { createHistoryController } = require('../app/history-controller.js');

// A stand-in for a page: it owns a document and replays a history entry by
// putting the recorded snapshot back — exactly what the scene/action/corpus
// restorers do, minus the IPC.
function fakePage(initial) {
  return {
    doc: JSON.parse(JSON.stringify(initial)),
    edits: 0,
    set(next) { this.doc = JSON.parse(JSON.stringify(next)); },
    restore(entry, direction) {
      const target = direction === 'undo' ? entry.before : entry.after;
      this.set(target);
      return { ok: true };
    },
  };
}

test('改 → ⌘Z → 断言回到前值 → ⇧⌘Z → 断言再前进', async () => {
  const history = createHistory({ limit: 50 });
  let topBarCalls = 0;
  const controller = createHistoryController({ history, onChange: () => { topBarCalls += 1; } });
  const page = fakePage({ items: ['desk'] });
  controller.register('scene', (entry, direction) => page.restore(entry, direction));

  const before = page.doc;
  page.set({ items: ['desk', 'sofa'] });
  const after = page.doc;
  controller.push({ label: '放进沙发', before, after, meta: { page: 'scene' } });

  const undone = await controller.step('undo');
  assert.equal(undone.ok, true);
  assert.deepEqual(page.doc, { items: ['desk'] }, 'undo puts the document back to the value before the edit');

  const redone = await controller.step('redo');
  assert.equal(redone.ok, true);
  assert.deepEqual(page.doc, { items: ['desk', 'sofa'] }, 'redo moves it forward again');
  assert.ok(topBarCalls >= 3, 'every push and step notifies the top bar');
});

test('a step whose page has no restorer is put back, not consumed', async () => {
  const history = createHistory();
  const controller = createHistoryController({ history });
  const page = fakePage({ n: 1 });
  controller.register('scene', (entry, direction) => page.restore(entry, direction));
  controller.push({ label: 'from an unknown page', before: { n: 0 }, after: { n: 1 }, meta: { page: 'mystery' } });

  const result = await controller.step('undo');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HISTORY_NO_RESTORER');
  assert.equal(result.page, 'mystery');
  // the step is still there: the next undo (once a restorer exists) can take it
  assert.deepEqual(history.size(), { undo: 1, redo: 0, limit: 50 });
  assert.equal(history.canUndo(), true);
});

test('a restorer that throws is reported, and the entry stays where the stack left it', async () => {
  const history = createHistory();
  const controller = createHistoryController({ history });
  controller.register('scene', () => { throw new Error('validator exploded'); });
  controller.push({ label: 'boom', before: 1, after: 2, meta: { page: 'scene' } });

  const result = await controller.step('undo');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HISTORY_RESTORE_THREW');
  assert.equal(result.label, 'boom');
  // the stack already moved the entry to the redo branch, so ⇧⌘Z is the way back
  assert.deepEqual(history.size(), { undo: 0, redo: 1, limit: 50 });
});

test('the redo branch dies on a new push (standard editor semantics)', async () => {
  const history = createHistory();
  const controller = createHistoryController({ history });
  const page = fakePage(0);
  controller.register('scene', (entry, direction) => page.restore(entry, direction));
  controller.push({ label: 'one', before: 0, after: 1, meta: { page: 'scene' } });
  await controller.step('undo');
  assert.equal(history.canRedo(), true, 'the undone step is redoable');
  controller.push({ label: 'two', before: 0, after: 2, meta: { page: 'scene' } });
  assert.equal(history.canRedo(), false, 'a new edit abandons the undone branch');
  assert.equal((await controller.step('redo')).ok, false, 'and there is nothing to redo');
});

test('an empty stack reports why, and says so through onChange', async () => {
  const history = createHistory();
  let notified = null;
  const controller = createHistoryController({ history, onChange: (summary) => { notified = summary; } });
  const undo = await controller.step('undo');
  assert.equal(undo.ok, false);
  assert.equal(undo.code, 'HISTORY_EMPTY');
  const redo = await controller.step('redo');
  assert.equal(redo.ok, false);
  assert.equal(redo.code, 'HISTORY_NO_REDO');
  assert.deepEqual(notified, { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, size: { undo: 0, redo: 0, limit: 50 } });
});

test('the summary is what the top bar reads: labels, order and availability', async () => {
  const history = createHistory({ limit: 50 });
  const controller = createHistoryController({ history });
  const page = fakePage(0);
  controller.register('scene', (entry, direction) => page.restore(entry, direction));

  assert.deepEqual(controller.summary(), { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, size: { undo: 0, redo: 0, limit: 50 } });

  controller.push({ label: 'first', before: 0, after: 1, meta: { page: 'scene' } });
  controller.push({ label: 'second', before: 1, after: 2, meta: { page: 'scene' } });
  assert.deepEqual(controller.summary(), {
    canUndo: true, canRedo: false,
    undoLabel: 'second',   // newest first: the step ⌘Z reverts next
    redoLabel: null,
    size: { undo: 2, redo: 0, limit: 50 },
  });

  await controller.step('undo');
  assert.deepEqual(controller.summary(), {
    canUndo: true, canRedo: true,
    undoLabel: 'first',
    redoLabel: 'second',   // oldest first: the step ⇧⌘Z applies next
    size: { undo: 1, redo: 1, limit: 50 },
  });
});

test('registering twice replaces, and the unsubscribe only removes its own', () => {
  const history = createHistory();
  const controller = createHistoryController({ history });
  const first = () => ({ ok: true });
  const second = () => ({ ok: true });
  const off = controller.register('scene', first);
  controller.register('scene', second);
  assert.deepEqual(controller.pages(), ['scene']);
  off();  // the FIRST registration's unsubscribe must not remove the second
  assert.deepEqual(controller.pages(), ['scene'], 'a stale unsubscribe is a no-op');
  const offSecond = controller.register('scene', second);
  offSecond();
  assert.deepEqual(controller.pages(), [], 'the live registration unsubscribes');
});

test('a bad construction is a programming error, not a silent fallback', () => {
  assert.throws(() => createHistoryController({}), /history stack/);
  assert.throws(() => createHistoryController({ history: createHistory(), onChange: 42 }), /onChange/);
  const controller = createHistoryController({ history: createHistory() });
  assert.throws(() => controller.register('', () => {}), /page name/);
  assert.throws(() => controller.register('scene', 'nope'), /must be a function/);
});

test('the controller never mutates the entry the restorer is handed', async () => {
  const history = createHistory();
  const controller = createHistoryController({ history });
  const entry = { label: 'x', before: { a: 1 }, after: { a: 2 }, meta: { page: 'scene' } };
  controller.push(entry);
  let seen = null;
  controller.register('scene', (handed) => { seen = handed; return { ok: true }; });
  await controller.step('undo');
  assert.notEqual(seen, entry, 'the restorer gets a copy of the envelope');
  assert.deepEqual(seen, { id: 1, label: 'x', before: { a: 1 }, after: { a: 2 }, meta: { page: 'scene' } });
});
