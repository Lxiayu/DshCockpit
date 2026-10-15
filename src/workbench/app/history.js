'use strict';

// src/workbench/app/history.js — the undo/redo stack (plan task T3, workbench
// UX rectification, 2026-09-29).
//
// WHY this exists: every workbench edit — the scene layout above all — already
// runs through the validated transaction in studio/lib/scene/edit.js (dry run,
// then a byte backup, then write). What the shell never had was a way BACK:
// ⌘Z hit nothing and one mistake cost the whole unsaved draft. The plan's fix
// is a 「整稿快照」 stack — layout.json is a small draft, so ≤50 whole-draft
// snapshots cost nothing.
//
// This module is the STACK ONLY, and it is deliberately pure:
//   * no DOM, no IPC, no file system, no timers, no module-level state — two
//     arrays and a counter inside one closure, so two instances never see each
//     other;
//   * it files `before`/`after` BY REFERENCE and never clones or mutates them.
//     The caller hands in deep-cloned snapshots (that is what makes them
//     snapshots) and keeps ownership; this module only remembers where they are;
//   * undo/redo RETURN the recorded entry. Replaying it is the caller's job and
//     it must go through the SAME validated transaction as any other edit
//     (撤销 = 用上一份快照走既有事务重放，仍必须过校验事务，不许绕过) — an undo
//     is an edit, not a bypass.
//
// Semantics are the editor-standard ones:
//   * a push while the redo branch is non-empty CLEARS the redo branch;
//   * undo pops the newest undoable step onto the redo branch and redo moves it
//     back, so a redo is consumed exactly once;
//   * the limit is enforced by dropping the OLDEST entries.
//
// peek() orders the lists the way a menu renders them: UNDO newest-first (the
// first element is the step ⌘Z reverts next — 「撤销：拖入电饭煲」) and REDO
// oldest-first (the first element is the step ⇧⌘Z applies next). peek() hands
// out summary entries only ({ id, label, meta }), never the payload, so a menu
// can never pin a snapshot the user is about to throw away.

const HISTORY_LIMIT_DEFAULT = 50;

// The stack size is a deliberate cap (memory is the reason there is a cap at
// all), so a nonsense value is a programming error, not something to silently
// reinterpret. null/undefined means "the caller has no opinion".
function resolveLimit(limit) {
  if (limit === undefined || limit === null) return HISTORY_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new TypeError(`history limit must be a non-negative integer, got ${String(limit)}`);
  }
  return limit;
}

// Fresh copy of a stored entry. `before`/`after`/`meta` are the CALLER's values
// and go back by reference (the caller owns cloning them); only the envelope is
// new, so poking a returned entry cannot corrupt the stack.
function expose(entry) {
  return { id: entry.id, label: entry.label, before: entry.before, after: entry.after, meta: entry.meta };
}

// What peek() returns: enough for a menu line, without the payload.
function summarize(entry) {
  return { id: entry.id, label: entry.label, meta: entry.meta };
}

function createHistory({ limit = HISTORY_LIMIT_DEFAULT } = {}) {
  const max = resolveLimit(limit);
  const undoStack = []; // undoable steps, oldest first; the LAST is the next ⌘Z
  const redoStack = []; // undone steps, oldest first; the FIRST is the next ⇧⌘Z
  // Ids never restart, not even across clear(): a UI may still be showing the
  // user an id that a cleared stack would otherwise re-issue.
  let nextId = 1;

  function push(step) {
    if (step === null || typeof step !== 'object') {
      throw new TypeError(`history push expects { label, before, after, meta }, got ${String(step)}`);
    }
    const { label, before, after, meta = null } = step;
    // A new step rewrites the future: whatever was redoable is now a branch the
    // user abandoned (standard editor semantics).
    redoStack.length = 0;
    undoStack.push({ id: nextId, label, before, after, meta });
    nextId += 1;
    // Drop the OLDEST entries: the newest edit is the one the user is working on.
    while (undoStack.length > max) undoStack.shift();
    return nextId - 1;
  }

  function undo() {
    const entry = undoStack.pop();
    if (!entry) return { ok: false, code: 'HISTORY_EMPTY' };
    redoStack.unshift(entry);
    // The caller re-applies entry.before (through the validated transaction).
    return { ok: true, entry: expose(entry) };
  }

  function redo() {
    const entry = redoStack.shift();
    if (!entry) return { ok: false, code: 'HISTORY_NO_REDO' };
    undoStack.push(entry);
    // The caller re-applies entry.after (through the validated transaction).
    return { ok: true, entry: expose(entry) };
  }

  function canUndo() {
    return undoStack.length > 0;
  }

  function canRedo() {
    return redoStack.length > 0;
  }

  function peek() {
    return {
      undo: undoStack.slice().reverse().map(summarize),
      redo: redoStack.map(summarize),
    };
  }

  function clear() {
    undoStack.length = 0;
    redoStack.length = 0;
  }

  function size() {
    return { undo: undoStack.length, redo: redoStack.length, limit: max };
  }

  return { push, undo, redo, canUndo, canRedo, peek, clear, size };
}

// dual module (the house pattern, see i18n.js): require()-able from Node AND loadable as a
// classic script in the page, where a bare `module.exports` would be a ReferenceError.
const wbHistoryApi = { HISTORY_LIMIT_DEFAULT, createHistory };
if (typeof window !== 'undefined') window.wbHistory = wbHistoryApi;
if (typeof module !== 'undefined' && module.exports) module.exports = wbHistoryApi;
