// test/session-files.test.js — generation-aware session log discovery (V3).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { generationOf, pickSessionFile, SESSION_FILE_RE } = require('../src/session-files');

test('generationOf parses v0/vN names in both encodings', () => {
  assert.ok(SESSION_FILE_RE instanceof RegExp);
  assert.strictEqual(generationOf('session.jsonl.zstd'), 0);
  assert.strictEqual(generationOf('session.jsonl'), 0);
  assert.strictEqual(generationOf('session.v1.jsonl.zstd'), 1);
  assert.strictEqual(generationOf('session.v3.jsonl'), 3);
  assert.strictEqual(generationOf('session.v10.jsonl.zstd'), 10);
});

test('generationOf ignores non-session files in the session directory', () => {
  for (const name of ['session.lock', 'session_projcache.json', 'notes.txt', 'other.jsonl', '', null, undefined]) {
    assert.strictEqual(generationOf(name), null, `${name} must not look like a session log`);
  }
});

test('pickSessionFile returns the highest generation, never several files', () => {
  assert.strictEqual(
    pickSessionFile(['session.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.v3.jsonl.zstd']),
    'session.v3.jsonl.zstd');
  assert.strictEqual(
    pickSessionFile(['session.v2.jsonl.zstd', 'session.jsonl.zstd']),
    'session.v2.jsonl.zstd');
  assert.strictEqual(pickSessionFile(['session.jsonl']), 'session.jsonl');
});

test('pickSessionFile discovers a v3-only session (new session on dsh 0.1.5)', () => {
  assert.strictEqual(pickSessionFile(['session.v3.jsonl.zstd']), 'session.v3.jsonl.zstd');
});

test('pickSessionFile ignores locks/caches and empty input; zstd wins a same-generation tie', () => {
  assert.strictEqual(pickSessionFile(['session.lock', 'session_projcache.json']), null);
  assert.strictEqual(pickSessionFile([]), null);
  assert.strictEqual(pickSessionFile(null), null);
  assert.strictEqual(pickSessionFile(['session.v3.jsonl', 'session.v3.jsonl.zstd']), 'session.v3.jsonl.zstd');
  assert.strictEqual(pickSessionFile(['session.v3.jsonl.zstd', 'session.v3.jsonl']), 'session.v3.jsonl.zstd');
});
