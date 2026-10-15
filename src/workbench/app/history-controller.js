'use strict';

// src/workbench/app/history-controller.js — the ONE undo/redo stack every page
// shares, and the dispatcher that replays a step through the page that owns it
// (workbench UX rectification, gap #1: 撤销/重做).
//
// WHY this exists on top of app/history.js: the stack itself was already pure
// and tested (studio/test/history.test.js), but only ONE page used it — the
// scene page pushed at its three writers and REPLACED the shell's ⌘Z handler
// with its own. Moving furniture, typing a coordinate, editing a frame order or
// editing a corpus line all landed nowhere, so a mistake still cost the whole
// unsaved draft. This module is the missing middle:
//
//   * a REGISTRY: every page that can push a step also registers the restorer
//     that replays it (the scene page replays through the validated scene
//     transaction, the action page through the action op's own restore, the
//     corpus page by putting its staged document back). A step is never
//     replayed by a page that does not own it.
//   * a DISPATCHER: step('undo'|'redo') pops the stack, looks the entry's page
//     up in the registry and hands the entry over. If no restorer is
//     registered the entry is put BACK where it came from — a step must never
//     be silently consumed by a page that cannot replay it.
//   * a SUMMARY for the top bar: canUndo/canRedo plus the label of the step
//     each button would perform (「撤销：拖入电饭煲」), which is what makes the
//     history legible instead of a grey arrow.
//
// It is deliberately pure like the modules it sits between: no DOM, no IPC, no
// timers, no module-level state. `onChange` is the one injection point — the
// shell passes its top-bar refresh so a push or a step updates the buttons.
//
// (No constant is declared here that another classic script also declares: every
// app/ module shares one global scope in the page, and a second
// `const HISTORY_LIMIT_DEFAULT` is a SyntaxError that kills the whole file.)

// Fresh copy of a stored entry — the same contract as history.js expose().
function copyEntry(entry) {
  return { id: entry.id, label: entry.label, before: entry.before, after: entry.after, meta: entry.meta };
}

// The page an entry belongs to. An entry without one can still be pushed (a
// caller may only want the snapshot recorded), but step() refuses to guess.
function pageOf(entry) {
  const meta = entry && entry.meta;
  return meta && typeof meta.page === 'string' ? meta.page : null;
}

function createHistoryController({ history, onChange = null } = {}) {
  if (!history || typeof history.push !== 'function' || typeof history.undo !== 'function') {
    throw new TypeError('historyController needs a history stack (app/history.js createHistory())');
  }
  if (onChange !== null && typeof onChange !== 'function') {
    throw new TypeError('historyController onChange must be a function or null');
  }
  const restorers = new Map();   // page → (entry, direction) => result | Promise<result>

  // A page registers once; registering twice REPLACES (the last wiring wins, the
  // same rule the shell's furniture drop handler follows). The returned function
  // unregisters — but only if it is still the registered one.
  function register(page, restore) {
    if (typeof page !== 'string' || page.length === 0) {
      throw new TypeError(`history register needs a page name, got ${String(page)}`);
    }
    if (typeof restore !== 'function') {
      throw new TypeError(`history restorer for "${page}" must be a function, got ${String(restore)}`);
    }
    restorers.set(page, restore);
    return () => { if (restorers.get(page) === restore) restorers.delete(page); };
  }

  function push(step) {
    const id = history.push(step);
    if (onChange) onChange(summary());
    return id;
  }

  async function step(direction) {
    const way = direction === 'redo' ? 'redo' : 'undo';
    const popped = way === 'undo' ? history.undo() : history.redo();
    if (!popped.ok) {
      // HISTORY_EMPTY / HISTORY_NO_REDO: nothing moved, but the top bar still has
      // to hear about it (a redo branch dies on the next push, not here)
      if (onChange) onChange(summary());
      return popped;
    }
    const page = pageOf(popped.entry);
    const restore = page ? restorers.get(page) : null;
    if (!restore) {
      // Put the entry back exactly where it was: an undo that cannot be replayed
      // must leave the stack as it found it, so the NEXT ⌘Z is still the step the
      // user meant to take.
      if (way === 'undo') history.redo(); else history.undo();
      if (onChange) onChange(summary());
      return { ok: false, code: 'HISTORY_NO_RESTORER', page: page || null };
    }
    let outcome;
    try {
      outcome = await restore(copyEntry(popped.entry), way);
    } catch (error) {
      // A restorer that THREW is a bug in the page, not a reason to lose the step:
      // the entry is already on the other branch (the stack moved), so report the
      // failure with the entry's label attached.
      outcome = { ok: false, code: 'HISTORY_RESTORE_THREW', label: popped.entry.label, message: String((error && error.message) || error) };
    }
    if (onChange) onChange(summary());
    return outcome || { ok: true };
  }

  function summary() {
    const peek = history.peek();
    return {
      canUndo: history.canUndo(),
      canRedo: history.canRedo(),
      // the step each button would perform, newest-first for undo / oldest-first
      // for redo — the same order peek() renders a menu in
      undoLabel: peek.undo.length > 0 ? peek.undo[0].label : null,
      redoLabel: peek.redo.length > 0 ? peek.redo[0].label : null,
      size: history.size(),
    };
  }

  return {
    register,
    push,
    step,
    summary,
    history,
    pages: () => Array.from(restorers.keys()),
  };
}

const wbHistoryControllerApi = { createHistoryController };
// dual module (the house pattern, see i18n.js): require()-able from Node AND loadable
// as a classic script in the page.
if (typeof window !== 'undefined') window.wbHistoryController = wbHistoryControllerApi;
if (typeof module !== 'undefined' && module.exports) module.exports = wbHistoryControllerApi;
