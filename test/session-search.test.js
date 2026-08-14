// test/session-search.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { searchSessions, extractText } = require('../src/session-search');

test('extractText pulls text from message blocks', () => {
  const ev = { type: 'assistant/message', data: { blocks: [{ type: 'text', text: 'hello world' }, { type: 'tool-call', name: 'fs_read', arguments: '{"p":"x"}' }] } };
  const t = extractText(ev);
  assert.ok(t.includes('hello world'));
  assert.ok(t.includes('fs_read'));
});

test('searchSessions finds substring across sessions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-search-'));
  const dir = path.join(home, 'sessions', 'proj', 'sess1');
  fs.mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ id: 'sess1', cwd: 'C:\\proj' });
  const ev = JSON.stringify({ type: 'assistant/message', data: { blocks: [{ type: 'text', text: 'the quick brown fox jumps over the lazy dog' }] } });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), [header, ev].join('\n') + '\n');

  const results = searchSessions(home, 'quick brown');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].id, 'sess1');
  assert.strictEqual(results[0].cwd, 'C:\\proj');
  assert.ok(results[0].snippet.includes('quick brown'));
  assert.ok(results[0].matchCount >= 1);

  assert.strictEqual(searchSessions(home, 'nonexistent').length, 0);
  assert.strictEqual(searchSessions(home, '').length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('searchSessions handles the real live log if present (zstd, small only)', () => {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  if (!fs.existsSync(root)) {
    console.log('  (skip: no real sessions)');
    return;
  }
  let total = 0;
  try {
    for (const f of fs.readdirSync(root, { recursive: true })) {
      try { total += fs.statSync(path.join(root, f)).size; } catch { /* ignore */ }
    }
  } catch { return; }
  if (total > 15 * 1024 * 1024) {
    console.log('  (skip: real session log too large for a unit test)');
    return;
  }
  const results = searchSessions(os.homedir() + '/.dsh', 'the');
  assert.ok(Array.isArray(results));
});
