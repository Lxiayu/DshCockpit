'use strict';

// test/work-ipc.test.js — v0.7 P1：工作台 IPC 的校验/委托/发送方信任。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createWorkIpc, isTrustedWorkSender, GOAL_MAX_CHARS } = require('../src/work/work-ipc.js');

function makeIpc(overrides = {}) {
  const calls = [];
  const base = {
    status: () => ({ ok: true, calls: calls.push('status') }),
    selectWorkspace: async (target) => { calls.push(['select', target]); return { ok: true }; },
    start: async (goal, verifyCommand) => { calls.push(['start', goal, verifyCommand]); return { ok: true }; },
    cancel: async () => { calls.push('cancel'); return { ok: true }; },
    resume: async () => { calls.push('resume'); return { ok: true }; },
    retry: async () => { calls.push('retry'); return { ok: true }; },
    expand: async () => { calls.push('expand'); return { ok: true }; },
    openArtifact: async (args) => { calls.push(['open', args]); return { ok: true, text: 'x' }; },
    focus: async (employeeId) => { calls.push(['focus', employeeId]); return { ok: true }; },
  };
  return { ipc: createWorkIpc({ ...base, ...overrides }), calls };
}

test('work-ipc: validates every action and fails closed on unknown/ambiguous payloads', () => {
  const { ipc } = makeIpc();
  assert.equal(ipc.validate(null).code, 'PAYLOAD_INVALID');
  assert.equal(ipc.validate([]).code, 'PAYLOAD_INVALID');
  assert.equal(ipc.validate({ action: 'nope' }).code, 'ACTION_UNKNOWN');
  assert.equal(ipc.validate({ action: 'select-workspace' }).code, 'WORKSPACE_TARGET_AMBIGUOUS');
  assert.equal(ipc.validate({ action: 'select-workspace', path: '/a', create: 'x' }).code, 'WORKSPACE_TARGET_AMBIGUOUS');
  assert.equal(ipc.validate({ action: 'start', goal: '   ' }).code, 'WORK_GOAL_REQUIRED');
  assert.equal(ipc.validate({ action: 'start', goal: 'x'.repeat(GOAL_MAX_CHARS + 1) }).code, 'WORK_GOAL_TOO_LONG');
  assert.equal(ipc.validate({ action: 'open-artifact', key: '' }).code, 'ARTIFACT_KEY_INVALID');
  assert.equal(ipc.validate({ action: 'open-artifact', key: 'k', verb: 'exec' }).code, 'ARTIFACT_ACTION_INVALID');
  assert.equal(ipc.validate({ action: 'start', goal: 'x', verifyCommand: 'y'.repeat(501) }).code, 'WORK_VERIFY_COMMAND_TOO_LONG');
  // P3.3: focus carries only a seat id; empty means "clear".
  assert.deepEqual(ipc.validate({ action: 'focus', employeeId: 'coder' }), { ok: true, action: 'focus', employeeId: 'coder' });
  assert.deepEqual(ipc.validate({ action: 'focus', employeeId: null }), { ok: true, action: 'focus', employeeId: null });
  assert.deepEqual(ipc.validate({ action: 'focus' }), { ok: true, action: 'focus', employeeId: null });
  assert.equal(ipc.validate({ action: 'focus', employeeId: 'bad id!' }).code, 'FOCUS_ID_INVALID');
  assert.equal(ipc.validate({ action: 'focus', employeeId: 'x'.repeat(65) }).code, 'FOCUS_ID_INVALID');
  assert.equal(ipc.validate({ action: 'focus', employeeId: '../etc/passwd' }).code, 'FOCUS_ID_INVALID');
  assert.equal(ipc.validate({ action: 'focus', employeeId: 42 }).code, 'FOCUS_ID_INVALID');
});

test('work-ipc: delegates with trimmed values (the goal is the only user text)', async () => {
  const { ipc, calls } = makeIpc();
  assert.deepEqual(await ipc.handle({ action: 'select-workspace', path: ' /tmp/ws ' }, true), { ok: true });
  assert.deepEqual(await ipc.handle({ action: 'select-workspace', create: 'demo' }, true), { ok: true });
  assert.deepEqual(await ipc.handle({ action: 'start', goal: '  研究主题  ' }, true), { ok: true });
  assert.deepEqual(await ipc.handle({ action: 'start', goal: '改代码', verifyCommand: ' npm test ' }, true), { ok: true });
  assert.deepEqual(await ipc.handle({ action: 'open-artifact', key: 'job:notes', verb: 'read' }, true), { ok: true, text: 'x' });
  assert.deepEqual(await ipc.handle({ action: 'resume' }, true), { ok: true });
  assert.deepEqual(await ipc.handle({ action: 'expand' }, true), { ok: true });
  assert.deepEqual(await ipc.handle({ action: 'retry' }, true), { ok: true });
  assert.deepEqual(await ipc.handle({ action: 'focus', employeeId: 'coder' }, true), { ok: true });
  assert.deepEqual(await ipc.handle({ action: 'focus', employeeId: null }, true), { ok: true });
  assert.deepEqual(calls, [
    ['select', { path: '/tmp/ws' }],
    ['select', { create: 'demo' }],
    ['start', '研究主题', ''],
    ['start', '改代码', 'npm test'],
    ['open', { key: 'job:notes', verb: 'read' }],
    'resume',
    'expand',
    'retry',
    ['focus', 'coder'],
    ['focus', null],
  ]);
});

test('work-ipc: untrusted senders are refused before any callback runs', async () => {
  const { ipc, calls } = makeIpc();
  const result = await ipc.handle({ action: 'status' }, false);
  assert.deepEqual(result, { ok: false, code: 'SENDER_UNTRUSTED' });
  assert.deepEqual(calls, []);
});

test('work-ipc: only the work view file URL is trusted', () => {
  const frame = (url) => ({ senderFrame: { url } });
  assert.equal(isTrustedWorkSender(frame('file:///Applications/DshCockpit/src/work/work.html')), true);
  assert.equal(isTrustedWorkSender(frame('file:///Users/x/src/work/work.html#x')), true);
  assert.equal(isTrustedWorkSender(frame('file:///Users/x/src/office/office.html')), false);
  assert.equal(isTrustedWorkSender(frame('https://evil.example/work/work.html')), false);
  assert.equal(isTrustedWorkSender(frame('file:///Users/x/src/work/not-work.html')), false);
  assert.equal(isTrustedWorkSender(frame('file:///Users/x/src/work/work.html.evil')), false);
  assert.equal(isTrustedWorkSender({}), false);
  assert.equal(isTrustedWorkSender(null), false);
});

test('work-ipc: register wires one channel and injects the trust verdict', async () => {
  const { ipc, calls } = makeIpc();
  const handlers = new Map();
  ipc.register({ handle: (channel, fn) => handlers.set(channel, fn) });
  assert.deepEqual([...handlers.keys()], ['shell:work']);
  const fn = handlers.get('shell:work');
  const trusted = { senderFrame: { url: 'file:///repo/src/work/work.html' } };
  await fn(trusted, { action: 'status' });
  await fn({ senderFrame: { url: 'file:///repo/src/office/office.html' } }, { action: 'status' });
  assert.deepEqual(calls, ['status']);
});
