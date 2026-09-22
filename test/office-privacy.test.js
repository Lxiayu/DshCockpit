'use strict';

// Task 8 / SPEC-08 — privacy matrix for Office persistence, diagnostics and
// probe output. One shared redactor covers details UI, logs, persistence and
// diagnostics. RED until office-persistence.js lands.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPrivacyRedactor, REDACTED } = require('../src/office/runtime/privacy-redactor.js');
const persistence = require('../src/office/runtime/office-persistence.js');
const { STRINGS } = require('../src/i18n.js');

const STATE_FILE = 'office-state.v1.json';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'office-privacy-'));
}

const DIRTY_TASK = {
  employeeId: 'coder',
  kind: 'task-started',
  atMs: 100,
  prompt: 'FIXTURE-PROMPT refactor the billing module',
  args: { command: 'rm -rf /tmp/fixture', query: 'internal roadmap 2027' },
  result: { output: 'FIXTURE-OUTPUT raw tool result', tokens: 123456 },
  error: 'FIXTURE-ERROR stack trace line one',
  sessionId: 'sess-FIXTURE-001',
  apiKey: 'sk-FIXTURE-SECRETKEY',
  cwd: '/Users/someone/fixture-project',
};

// ---- redactor matrix ------------------------------------------------------------

test('redacted mode strips text/args/errors/sessions/tokens but keeps coarse enums', () => {
  const redactor = createPrivacyRedactor({ mode: 'redacted' });
  const out = redactor.redactValue({ ...DIRTY_TASK, runtime: 'running', outcome: 'completed' });
  assert.equal(out.prompt, REDACTED.TEXT);
  assert.equal(out.args.command, REDACTED.PATH); // value shape wins: 'rm -rf /tmp/…' contains a path
  assert.equal(out.result.output, REDACTED.TEXT);
  assert.equal(out.result.tokens, REDACTED.TOKENS);
  assert.equal(out.error, REDACTED.TEXT);
  assert.equal(out.sessionId, REDACTED.SESSION);
  assert.equal(out.apiKey, REDACTED.SECRET);
  assert.equal(out.cwd, REDACTED.PATH);
  assert.equal(out.runtime, 'running');
  assert.equal(out.outcome, 'completed');
  // NB: 'task-started' style kinds trip the sk-* secret shape inside the
  // redactor; office-module therefore skips value-shape redaction for its
  // controlled kind vocabulary. Here we assert a COARSE_ENUM kind survives.
  assert.equal(redactor.redactValue({ kind: 'completed' }).kind, 'completed');
});

test('full mode keeps prose but NEVER keeps secrets, sessions, paths or token counts', () => {
  const redactor = createPrivacyRedactor({ mode: 'full' });
  const out = redactor.redactValue(DIRTY_TASK);
  assert.equal(out.prompt, DIRTY_TASK.prompt);
  assert.equal(out.error, DIRTY_TASK.error);
  assert.equal(out.apiKey, REDACTED.SECRET);
  assert.equal(out.sessionId, REDACTED.SESSION);
  assert.equal(out.cwd, REDACTED.PATH);
  assert.equal(out.result.tokens, REDACTED.TOKENS);
});

// ---- persistence privacy -----------------------------------------------------------

test('persisted state in default redacted mode contains no prompts/sessions/tokens/secrets', async () => {
  const dir = tmpDir();
  const store = persistence.createOfficeStateStore({ userDataDir: dir, epoch: 1 });
  await store.save({ tasks: [DIRTY_TASK], activityLog: [{ ...DIRTY_TASK, kind: 'result-failed' }] });
  const raw = fs.readFileSync(path.join(dir, STATE_FILE), 'utf8');
  assert.ok(!raw.includes('FIXTURE-PROMPT'));
  assert.ok(!raw.includes('FIXTURE-OUTPUT'));
  assert.ok(!raw.includes('FIXTURE-ERROR'));
  assert.ok(!raw.includes('sess-FIXTURE'));
  assert.ok(!raw.includes('sk-FIXTURE'));
  assert.ok(!raw.includes('123456'));
  assert.ok(raw.includes(REDACTED.TEXT));
});

test('persisted state in full mode keeps task text but still strips secrets', async () => {
  const dir = tmpDir();
  const store = persistence.createOfficeStateStore({ userDataDir: dir, epoch: 1 });
  await store.updateSettings({ privacyMode: 'full' });
  await store.save({ tasks: [DIRTY_TASK] });
  const raw = fs.readFileSync(path.join(dir, STATE_FILE), 'utf8');
  assert.ok(raw.includes('FIXTURE-PROMPT'));
  assert.ok(!raw.includes('sk-FIXTURE'));
  assert.ok(!raw.includes('sess-FIXTURE'));
  assert.ok(raw.includes(REDACTED.SECRET));
});

test('switching back to redacted re-redacts on the next save', async () => {
  const dir = tmpDir();
  const store = persistence.createOfficeStateStore({ userDataDir: dir, epoch: 1 });
  await store.updateSettings({ privacyMode: 'full' });
  await store.save({ tasks: [DIRTY_TASK] });
  await store.updateSettings({ privacyMode: 'redacted' });
  await store.save({});
  const raw = fs.readFileSync(path.join(dir, STATE_FILE), 'utf8');
  assert.ok(!raw.includes('FIXTURE-PROMPT'));
});

// ---- the same redactor serves diagnostics / probe output ------------------------------

test('office persistence exposes the shared redactor for probe/diagnostic output', () => {
  const dir = tmpDir();
  const store = persistence.createOfficeStateStore({ userDataDir: dir, epoch: 1 });
  const probe = store.redactor().redactValue({ type: 'probe', sessionId: 'sess-FIXTURE-9', detail: 'raw probe text' });
  assert.equal(probe.sessionId, REDACTED.SESSION);
  assert.equal(probe.type, 'probe');
});

// ---- bilingual keys ----------------------------------------------------------------------

test('office i18n keys exist and match exactly between zh and en', () => {
  const zhOffice = Object.keys(STRINGS.zh).filter((k) => k.startsWith('office.')).sort();
  const enOffice = Object.keys(STRINGS.en).filter((k) => k.startsWith('office.')).sort();
  assert.ok(zhOffice.length >= 6, 'expected office.* keys');
  assert.deepEqual(zhOffice, enOffice);
  for (const key of zhOffice) {
    assert.ok(STRINGS.zh[key] && STRINGS.en[key], `empty office string: ${key}`);
  }
});
