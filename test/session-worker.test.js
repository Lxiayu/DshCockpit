'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionWorkerClient } = require('../src/session-worker-client');

const clients = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

function makeHome(text) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-worker-'));
  const dir = path.join(home, 'sessions', 'project', 'session');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), text);
  return home;
}

test('session worker returns usage snapshots without blocking the client', async () => {
  const home = makeHome([
    JSON.stringify({ id: 's1', cwd: '/tmp/project' }),
    JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 4 } } }),
  ].join('\n') + '\n');
  const client = createSessionWorkerClient();
  clients.push(client);
  const result = await client.collect(home, { windows: [[9, 12]] });
  assert.equal(result.sessionCount, 1);
  assert.equal(result.totals.input, 12);
  assert.equal(result.current.input, 12);
  fs.rmSync(home, { recursive: true, force: true });
});

test('identical in-flight collection requests share one worker job', async () => {
  const home = makeHome(JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: 5 } } }) + '\n');
  const client = createSessionWorkerClient();
  clients.push(client);
  const [a, b] = await Promise.all([client.collect(home), client.collect(home)]);
  assert.deepEqual(a, b);
  assert.equal(client.stats().jobs, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('worker client can be reset after a failed job', async () => {
  const client = createSessionWorkerClient({ workerPath: path.join(os.tmpdir(), 'missing-session-worker.js') });
  clients.push(client);
  await assert.rejects(client.collect('/tmp/does-not-exist'), /worker|ENOENT|not found/i);
  assert.equal(client.stats().pending, 0);
});
