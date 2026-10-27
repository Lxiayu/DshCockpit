'use strict';

// test/command-runner.test.js — v0.7 P2 WP3：验证命令执行器（超时/输出上限/cwd）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createCommandRunner } = require('../src/work/command-runner.js');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => { child.killedWith = signal; setImmediate(() => child.emit('close', null, signal)); };
  return child;
}

function setup(overrides = {}) {
  const children = [];
  const runner = createCommandRunner({
    platform: 'darwin',
    spawnImpl: (bin, args, options) => {
      const child = fakeChild();
      children.push({ bin, args, options, child });
      return child;
    },
    timeoutMs: 50,
    maxOutputBytes: 16,
    ...overrides,
  });
  return { runner, children };
}

test('command-runner: runs through a shell in the given cwd and reports exit 0', async () => {
  const { runner, children } = setup();
  const pending = runner.run({ command: 'npm test', cwd: '/tmp/ws' });
  await new Promise((r) => setImmediate(r));
  children[0].child.stdout.write('hello');
  children[0].child.emit('close', 0, null);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'hello');
  assert.deepEqual(children[0].args, ['-c', 'npm test']);
  assert.equal(children[0].options.cwd, '/tmp/ws');
});

test('command-runner: a non-zero exit is not ok; stderr is included', async () => {
  const { runner, children } = setup();
  const pending = runner.run({ command: 'false', cwd: '/tmp/ws' });
  await new Promise((r) => setImmediate(r));
  children[0].child.stderr.write('boom');
  children[0].child.emit('close', 1, null);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes('boom'));
});

test('command-runner: output is bounded and marked truncated', async () => {
  const { runner, children } = setup({ maxOutputBytes: 8 });
  const pending = runner.run({ command: 'yes', cwd: '/tmp/ws' });
  await new Promise((r) => setImmediate(r));
  children[0].child.stdout.write('0123456789abcdef');
  children[0].child.emit('close', 0, null);
  const result = await pending;
  assert.equal(result.output, '01234567');
  assert.equal(result.truncated, true);
});

test('command-runner: a timeout kills the child and reports VERIFY_TIMEOUT', async () => {
  const { runner, children } = setup({ timeoutMs: 20 });
  const pending = runner.run({ command: 'sleep 100', cwd: '/tmp/ws' });
  await new Promise((r) => setImmediate(r));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.code, 'VERIFY_TIMEOUT');
  assert.equal(children[0].child.killedWith, 'SIGTERM');
});

test('command-runner: missing command or cwd fails closed without spawning', async () => {
  const { runner, children } = setup();
  assert.equal((await runner.run({ command: '  ', cwd: '/tmp' })).code, 'VERIFY_COMMAND_REQUIRED');
  assert.equal((await runner.run({ command: 'echo', cwd: '' })).code, 'VERIFY_CWD_REQUIRED');
  assert.equal(children.length, 0);
});

test('command-runner: the real shell path executes in the workspace (POSIX)', { skip: process.platform === 'win32' }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-real-'));
  const runner = createCommandRunner({ timeoutMs: 10_000, maxOutputBytes: 4096 });
  const result = await runner.run({ command: 'pwd && printf ok', cwd: workspace });
  assert.equal(result.ok, true);
  assert.ok(result.output.includes(workspace), 'the command really ran in the workspace');
  assert.ok(result.output.includes('ok'));
});
