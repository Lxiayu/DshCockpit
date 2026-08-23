// test/crash-reason.test.js — H5 startup-failure root-cause detection:
// recognizes the 0.1.0 → 0.1.1 credential-format signature in runtime log
// tails; anything else must keep the original (bare code/signal) behavior.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectCredentialFormatMismatch, readLogTail } = require('../src/crash-reason');

test('recognizes the v1-credentials-vs-flat-parser signature (real crash shapes)', () => {
  // rc.8 flat parser rejecting the numeric `version` key of the v1 file
  assert.strictEqual(detectCredentialFormatMismatch(
    'Error: YAMLException: bad indentation? at .credentials.yaml\n'
    + 'must be a string\n    at loadCredentials (/x/@deepseek-ai/dsh/lib/credentials.js:12:9)'
  ), true);
  // rejection moved onto `refs` after the user deleted the version line
  assert.strictEqual(detectCredentialFormatMismatch(
    'Failed to parse ~/.dsh/.credentials.yaml:\n  refs: must be a string'
  ), true);
  // a NEW runtime reading a legacy flat file
  assert.strictEqual(detectCredentialFormatMismatch(
    'error: pre-release flat layout detected in credentials; run `dsh login` to migrate'
  ), true);
  // v1 keywords with credential context, no explicit type error
  assert.strictEqual(detectCredentialFormatMismatch(
    'cannot read .credentials.yaml: unknown field "version", expected refs entries'
  ), true);
});

test('ordinary crashes do NOT trigger the upgrade dialog', () => {
  assert.strictEqual(detectCredentialFormatMismatch(''), false);
  assert.strictEqual(detectCredentialFormatMismatch(null), false);
  // generic spawn failure / plugin crash — no credential context
  assert.strictEqual(detectCredentialFormatMismatch('runtime exited code=1\nError: Cannot find module @deepseek-ai/dsh-agent-presets'), false);
  assert.strictEqual(detectCredentialFormatMismatch('EADDRINUSE: port 3000 already in use, version mismatch elsewhere'), false);
  // "must be a string" without credential context (unrelated YAML error)
  assert.strictEqual(detectCredentialFormatMismatch('settings.yaml: name must be a string'), false);
});

test('readLogTail reads only the tail and tolerates missing files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-log-'));
  const file = path.join(dir, 'runtime.out');
  fs.writeFileSync(file, 'x'.repeat(100) + 'must be a string at .credentials.yaml');
  const tail = readLogTail(file);
  assert.match(tail, /must be a string/);
  assert.ok(tail.length <= 16_000 + 64);
  assert.strictEqual(readLogTail(path.join(dir, 'nope.out')), null);
});

test('REGRESSION (v0.2.8 incident): large logs return ONLY the tail — not the whole file', () => {
  // the old destructuring bug made bytesRead undefined and
  // buf.toString('utf8', 0, undefined) silently returned EVERYTHING,
  // which let this suite pass while readLogTail was broken
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-log-'));
  const file = path.join(dir, 'big.out');
  const headMark = 'HEAD-MARKER-0123456789';
  const head = headMark + 'a'.repeat(19_978); // > TAIL_CHARS (16_000), no signature
  fs.writeFileSync(file, head + '\nmust be a string at .credentials.yaml\n');
  const tail = readLogTail(file);
  assert.ok(tail.length <= 16_000 + 64, `tail is bounded (${tail.length})`);
  assert.ok(!tail.includes(headMark), 'the far-away head marker must not appear in the tail');
  assert.match(tail, /must be a string at \.credentials\.yaml/);
});
