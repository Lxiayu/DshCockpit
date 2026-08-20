'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { QUICK_ASK_HOTKEYS, createQuickAskShortcutManager } = require('../src/quickask-shortcut');

function fixture(initial = '') {
  const calls = [];
  const registered = new Set();
  const globalShortcut = {
    register(hotkey) { calls.push(`register:${hotkey}`); registered.add(hotkey); return true; },
    unregister(hotkey) { calls.push(`unregister:${hotkey}`); registered.delete(hotkey); },
  };
  const manager = createQuickAskShortcutManager({ globalShortcut, onTrigger: () => {} });
  if (initial) manager.start(initial);
  calls.length = 0;
  return { manager, calls, registered, globalShortcut };
}

test('shortcut allowlist contains two presets, Alt+Space, and Disabled', () => {
  assert.deepEqual([...QUICK_ASK_HOTKEYS], [
    'CommandOrControl+Alt+Space',
    'CommandOrControl+Shift+Space',
    'Alt+Space',
    '',
  ]);
});

test('startup registration and idempotent updates own exactly one accelerator', () => {
  const { manager, calls, registered } = fixture();
  assert.deepEqual(manager.start('CommandOrControl+Alt+Space'), { ok: true, active: 'CommandOrControl+Alt+Space' });
  assert.deepEqual(manager.set('CommandOrControl+Alt+Space'), { ok: true, active: 'CommandOrControl+Alt+Space' });
  assert.deepEqual(calls, ['register:CommandOrControl+Alt+Space']);
  assert.deepEqual([...registered], ['CommandOrControl+Alt+Space']);
});

test('successful switch registers the new accelerator before releasing the old one and then persists', () => {
  const { manager, calls } = fixture('CommandOrControl+Alt+Space');
  const persisted = [];
  const result = manager.set('CommandOrControl+Shift+Space', (value) => persisted.push(value));
  assert.deepEqual(result, { ok: true, active: 'CommandOrControl+Shift+Space' });
  assert.deepEqual(calls, ['register:CommandOrControl+Shift+Space', 'unregister:CommandOrControl+Alt+Space']);
  assert.deepEqual(persisted, ['CommandOrControl+Shift+Space']);
});

test('failed new registration preserves the old accelerator and does not persist', () => {
  const { manager, calls, registered, globalShortcut } = fixture('CommandOrControl+Alt+Space');
  globalShortcut.register = (hotkey) => { calls.push(`register:${hotkey}`); return false; };
  const persisted = [];
  const result = manager.set('CommandOrControl+Shift+Space', (value) => persisted.push(value));
  assert.deepEqual(result, { ok: false, code: 'unavailable', active: 'CommandOrControl+Alt+Space' });
  assert.deepEqual(calls, ['register:CommandOrControl+Shift+Space']);
  assert.deepEqual([...registered], ['CommandOrControl+Alt+Space']);
  assert.deepEqual(persisted, []);
});

test('Disabled unregisters the tracked accelerator and persists an empty value', () => {
  const { manager, calls, registered } = fixture('CommandOrControl+Alt+Space');
  const persisted = [];
  assert.deepEqual(manager.set('', (value) => persisted.push(value)), { ok: true, active: '' });
  assert.deepEqual(calls, ['unregister:CommandOrControl+Alt+Space']);
  assert.deepEqual([...registered], []);
  assert.deepEqual(persisted, ['']);
});

test('shutdown unregisters only the accelerator tracked by this manager', () => {
  const { manager, calls, registered } = fixture('Alt+Space');
  registered.add('Control+9');
  manager.shutdown();
  assert.deepEqual(calls, ['unregister:Alt+Space']);
  assert.deepEqual([...registered], ['Control+9']);
});
