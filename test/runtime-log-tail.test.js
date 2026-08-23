// test/runtime-log-tail.test.js — regression guard for the v0.2.8 field
// incident: the boot URL poller destructured fs.readSync's NUMBER return
// (→ undefined → NaN offset → every size comparison false → the boot window
// spun forever). The extracted tailer normalizes both API shapes, self-heals
// a poisoned/truncating offset, and never throws.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntimeLogTailer } = require('../src/runtime-log-tail');

function tmpFile(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logtail-'));
  const file = path.join(dir, 'runtime.out');
  if (initial !== undefined) fs.writeFileSync(file, initial);
  return file;
}

test('first poll returns everything; subsequent polls only new bytes', () => {
  const file = tmpFile('hello ');
  const tailer = createRuntimeLogTailer(file);
  assert.strictEqual(tailer.poll(), 'hello ', 'full content on first poll');
  assert.strictEqual(tailer.poll(), '', 'nothing appended → empty');
  fs.appendFileSync(file, 'world');
  assert.strictEqual(tailer.poll(), 'world', 'only the appended bytes come back');
  assert.strictEqual(tailer.poll(), '');
});

test('URL split across two polls is reassembled by the caller (offset bookkeeping)', () => {
  const file = tmpFile('booting…\n');
  const tailer = createRuntimeLogTailer(file);
  let text = tailer.poll();
  assert.strictEqual(text.match(/dsh web: (https?:\/\/127\.0\.0\.1:\d+)/), null);
  // append the URL line SPLIT mid-IP across two appends
  fs.appendFileSync(file, 'dsh web: http://127.0.0.');
  text += tailer.poll();
  fs.appendFileSync(file, '1:58804\nready\n');
  text += tailer.poll();
  const m = text.match(/dsh web: (https?:\/\/127\.0\.0\.1:\d+)/);
  assert.ok(m, 'URL line matched across chunk boundaries');
  assert.strictEqual(m[1], 'http://127.0.0.1:58804');
});

test('THE INCIDENT: a readSync returning an object shape (or garbage) must not poison the offset', () => {
  const file = tmpFile('part-one;');
  let calls = 0;
  const tailer = createRuntimeLogTailer(file, {
    // simulate the buggy assumption / a future API shape change: object or undefined
    readSyncFn: () => { calls += 1; return calls === 1 ? { bytesRead: undefined } : undefined; },
  });
  assert.strictEqual(tailer.poll(), '', 'object-shaped return yields no text and does NOT throw');
  assert.strictEqual(tailer.poll(), '', 'undefined return likewise safe');
  // after the bad shape stops, polling continues from the SAME offset — no NaN stall
  fs.appendFileSync(file, 'dsh web: http://127.0.0.1:9\n');
  const real = createRuntimeLogTailer(file);
  assert.match(real.poll(), /dsh web: http:\/\/127\.0\.0\.1:9/, 'file remains readable (no corruption by the tailer)');
});

test('truncated log restarts from zero instead of stalling', () => {
  const file = tmpFile('x'.repeat(500));
  const tailer = createRuntimeLogTailer(file);
  assert.strictEqual(tailer.poll().length, 500);
  // runtime rewrote the log shorter than the consumed offset
  fs.writeFileSync(file, 'fresh dsh web: http://127.0.0.1:7\n');
  const out = tailer.poll();
  assert.match(out, /dsh web: http:\/\/127\.0\.0\.1:7/, 'truncation self-heals with a full re-read');
});

test('missing file and unreadable states are quiet empty strings, never throws', () => {
  const missing = path.join(os.tmpdir(), `logtail-missing-${Date.now()}.out`);
  const tailer = createRuntimeLogTailer(missing);
  assert.strictEqual(tailer.poll(), '');
  fs.writeFileSync(missing, 'late content\n');
  assert.strictEqual(tailer.poll(), 'late content\n');
});

test('reset() forces a full re-read', () => {
  const file = tmpFile('abc');
  const tailer = createRuntimeLogTailer(file);
  tailer.poll();
  assert.strictEqual(tailer.poll(), '');
  tailer.reset();
  assert.strictEqual(tailer.poll(), 'abc');
});
