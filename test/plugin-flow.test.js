// test/plugin-flow.test.js — unit tests for the plugin install/remove flow
// helpers (serialization guard, failure classification, cleanup decision,
// output summarizing, stage inference). Pure module — no electron needed.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  createPluginOpGuard, failureCode, shouldCleanupAfterFailure, summarizeOutput, inferStage,
} = require('../src/plugin-flow');

test('guard rejects a second concurrent plugin op', () => {
  const guard = createPluginOpGuard();
  assert.strictEqual(guard.tryBegin('install', 'a/b'), true);
  assert.strictEqual(guard.tryBegin('install', 'c/d'), false, 'must serialize');
  assert.deepStrictEqual(guard.current, { action: 'install', fullName: 'a/b', startedAt: guard.current.startedAt });
});

test('guard allows the next op after release', () => {
  const guard = createPluginOpGuard();
  guard.tryBegin('remove', 'a/b');
  guard.release();
  assert.strictEqual(guard.current, null);
  assert.strictEqual(guard.tryBegin('install', 'c/d'), true);
  guard.release();
});

test('failureCode classifies timeout / spawn / exit results', () => {
  assert.strictEqual(failureCode({ ok: false, code: 'timeout', output: 'timeout' }), 'timeout');
  assert.strictEqual(failureCode({ ok: false, output: 'timeout' }), 'timeout', 'legacy result without code');
  assert.strictEqual(failureCode({ ok: false, code: 'spawn', output: 'ENOENT' }), 'spawn');
  assert.strictEqual(failureCode({ ok: false, code: 'exit', output: 'boom' }), 'exit');
  assert.strictEqual(failureCode(null), 'exit');
});

test('cleanup runs after a failed install but not after a failed remove', () => {
  assert.strictEqual(shouldCleanupAfterFailure('install'), true);
  assert.strictEqual(shouldCleanupAfterFailure('remove'), false);
});

test('summarizeOutput prefers error lines and caps length', () => {
  const out = 'npm warn config\nadded 3 packages\nnpm error code E404\nnpm error 404 Not Found - GET https://registry/x\n';
  const s = summarizeOutput(out);
  assert.match(s, /E404/);
  assert.ok(s.length <= 600);
  assert.strictEqual(summarizeOutput('   \n\n'), '');
  const long = Array.from({ length: 50 }, (_, i) => `line ${i} error`).join('\n');
  assert.ok(summarizeOutput(long).length <= 600, 'capped at 600 chars');
});

test('inferStage maps npm/git output chunks to coarse stages', () => {
  assert.strictEqual(inferStage('resolved 15 packages fetching metadata'), 'resolve');
  assert.strictEqual(inferStage('Cloning into bare repository...'), 'download');
  assert.strictEqual(inferStage('added 12 packages in 3s'), 'install');
  assert.strictEqual(inferStage('running postinstall script'), 'install');
  assert.strictEqual(inferStage(''), null);
  assert.strictEqual(inferStage('something unrelated'), null);
});
