'use strict';

const QUICK_ASK_HOTKEYS = new Set([
  'CommandOrControl+Alt+Space',
  'CommandOrControl+Shift+Space',
  'Alt+Space',
  '',
]);

function normalizeQuickAskShortcut(value) {
  return typeof value === 'string' && QUICK_ASK_HOTKEYS.has(value) ? value : null;
}

function createQuickAskShortcutManager(options) {
  const opts = options || {};
  const shortcuts = opts.globalShortcut;
  const onTrigger = typeof opts.onTrigger === 'function' ? opts.onTrigger : () => {};
  let active = '';

  function register(value) {
    try { return shortcuts.register(value, onTrigger) === true; } catch { return false; }
  }

  function unregister(value) {
    if (!value) return;
    try { shortcuts.unregister(value); } catch { /* best effort */ }
  }

  function set(value, persist) {
    const next = normalizeQuickAskShortcut(value);
    if (next === null) return { ok: false, code: 'invalid', active };
    if (next === active) return { ok: true, active };
    const previous = active;

    if (next && !register(next)) return { ok: false, code: 'unavailable', active };
    if (previous) unregister(previous);

    try {
      if (typeof persist === 'function') persist(next);
    } catch {
      if (previous) register(previous);
      if (next) unregister(next);
      return { ok: false, code: 'persist', active: previous };
    }

    active = next;
    return { ok: true, active };
  }

  return {
    start(value) { return set(value); },
    set,
    current() { return active; },
    shutdown() { unregister(active); active = ''; },
  };
}

module.exports = { QUICK_ASK_HOTKEYS, normalizeQuickAskShortcut, createQuickAskShortcutManager };
