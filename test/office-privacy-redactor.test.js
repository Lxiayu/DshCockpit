'use strict';

// Task 1 / SPEC-01 shared privacy redactor contract.
// RED: src/office/runtime/privacy-redactor.js does not exist yet.
// The redactor is pure deterministic CommonJS, reusable by SPEC-05 (adapter
// hashing) and SPEC-08 (diagnostics/persistence): it removes prompt text,
// tool arguments/results, Session IDs, paths, token counts and secrets while
// preserving coarse event/status fields.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { createPrivacyRedactor, REDACTED } = require(
  path.join(ROOT, 'src', 'office', 'runtime', 'privacy-redactor.js')
);

test('redactText replaces prompt text with a stable deterministic placeholder', () => {
  const redactor = createPrivacyRedactor();
  assert.equal(redactor.redactText('please fix the login bug, use token 12345'), REDACTED.TEXT);
  assert.equal(
    redactor.redactText('please fix the login bug, use token 12345'),
    redactor.redactText('please fix the login bug, use token 12345')
  );
  assert.equal(redactor.redactText(''), '');
  assert.equal(redactor.redactText(null), '');
});

test('redactValue removes session ids, paths, tokens and secrets but keeps coarse enums', () => {
  const redactor = createPrivacyRedactor();
  const input = {
    status: 'running',
    reason: 'completed',
    type: 'tool/call',
    sessionId: 'sess-FIXTURE-001',
    runId: 'run-FIXTURE-1',
    cwd: '/Users/someone/secret-project',
    args: { command: 'rm -rf /', query: 'internal roadmap' },
    result: { output: 'FIXTURE-OUTPUT', tokens: 987654 },
    apiKey: 'sk-FIXTURE-SECRET',
    userMessage: 'FIXTURE-PROMPT',
    nested: { deeper: [{ secret: 'hunter2', note: 'note text' }] },
    count: 3,
  };
  const out = redactor.redactValue(input);
  assert.equal(out.status, 'running');
  assert.equal(out.reason, 'completed');
  assert.equal(out.type, 'tool/call');
  assert.equal(out.sessionId, REDACTED.SESSION);
  assert.equal(out.runId, REDACTED.SESSION);
  assert.equal(out.cwd, REDACTED.PATH);
  assert.equal(out.args.command, REDACTED.TEXT);
  assert.equal(out.result.tokens, REDACTED.TOKENS);
  assert.equal(out.apiKey, REDACTED.SECRET);
  assert.equal(out.userMessage, REDACTED.TEXT);
  assert.equal(out.nested.deeper[0].secret, REDACTED.SECRET);
  assert.equal(out.nested.deeper[0].note, REDACTED.TEXT);
  assert.equal(out.count, 3);

  // pure: input is never mutated
  assert.equal(input.args.command, 'rm -rf /');
  assert.equal(input.result.tokens, 987654);
  // deterministic
  assert.deepEqual(redactor.redactValue(input), out);
});

test('sensitive value shapes are redacted even when the key name is innocent', () => {
  const redactor = createPrivacyRedactor();
  assert.equal(redactor.redactValue({ note: '/Users/xia/program/dsh' }).note, REDACTED.PATH);
  assert.equal(
    redactor.redactValue({ note: 'sess-8f2c1a90-1234-4abc-9def-001122334455' }).note,
    REDACTED.SESSION
  );
  assert.equal(redactor.redactValue({ note: 'Bearer abc.def.ghi' }).note, REDACTED.SECRET);
  assert.equal(redactor.redactValue({ note: 'sk-live-abcdef123456' }).note, REDACTED.SECRET);
  assert.equal(redactor.redactValue({ note: 'run-FIXTURE-1' }).note, REDACTED.SESSION);
});

test('full mode keeps readable text but still strips session ids, paths and secrets', () => {
  const full = createPrivacyRedactor({ mode: 'full' });
  assert.equal(full.redactText('hello'), 'hello');
  assert.equal(full.redactValue({ userMessage: 'FIXTURE-PROMPT' }).userMessage, 'FIXTURE-PROMPT');
  assert.equal(full.redactValue({ sessionId: 'sess-FIXTURE-001' }).sessionId, REDACTED.SESSION);
  assert.equal(full.redactValue({ apiKey: 'sk-FIXTURE-SECRET' }).apiKey, REDACTED.SECRET);
  assert.equal(full.redactValue({ cwd: '/Users/someone/x' }).cwd, REDACTED.PATH);
});

test('redactEvent keeps only type/seq/time and data key names', () => {
  const redactor = createPrivacyRedactor();
  const out = redactor.redactEvent({
    type: 'tool/call',
    seq: 2,
    time: 5,
    data: { tool: 'bash', args: { command: 'rm -rf /' }, sessionId: 'sess-9' },
  });
  assert.deepEqual(out, {
    type: 'tool/call',
    seq: 2,
    time: 5,
    dataKeys: ['args', 'sessionId', 'tool'],
  });
  const json = JSON.stringify(out);
  assert.ok(!json.includes('rm -rf'), 'no tool payload');
  assert.ok(!json.includes('sess-9'), 'no session id');
});

test('redactor is pure CommonJS: no electron, pixi, fs or network usage', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src', 'office', 'runtime', 'privacy-redactor.js'),
    'utf8'
  );
  assert.match(src, /['"]use strict['"]/);
  assert.doesNotMatch(src, /require\(\s*['"]electron['"]/);
  assert.doesNotMatch(src, /require\(\s*['"]pixi/);
  assert.doesNotMatch(src, /require\(\s*['"]node:fs['"]/);
  assert.doesNotMatch(src, /require\(\s*['"]fs['"]/);
  assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest/);
});
