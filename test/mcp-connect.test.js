// test/mcp-connect.test.js — two-tier health checks (T1, v0.3.1)
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const mc = require('../src/mcp-connect');

/** Minimal fake child for probeStdio: responds to initialize + tools/list. */
function fakeChild({ script, delay = 0, respondTools = true }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => true, end: () => {} };
  child.kill = () => { child.killed = true; };
  child.killed = false;
  child.spawnsWith = null;
  const origWrite = child.stdin.write;
  child.stdin.write = (data) => {
    child.written = (child.written || '') + data;
    let msg;
    try { msg = JSON.parse(data); } catch { return true; }
    if (msg.id === 1) {
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'x' } } }) + '\n'));
      }, delay);
    }
    if (msg.id === 2) {
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({
          jsonrpc: '2.0', id: 2,
          result: respondTools ? { tools: [{ name: 'read_file' }, { name: 'write_file' }, { nope: true }] } : {},
        }) + '\n'));
      }, delay);
    }
    return origWrite(data);
  };
  child.__script = script;
  return child;
}

test('probeStdio: full handshake resolves the tool list and kills the child', async () => {
  const child = fakeChild({});
  const r = await mc.probeStdio({
    command: 'fake', args: ['a'], env: { TOKEN: 'v' }, timeoutMs: 2000,
    spawnImpl: (cmd, args, opts) => {
      child.spawnsWith = { cmd, args, env: opts.env };
      setTimeout(() => child.emit('spawn'), 0);
      return child;
    },
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.tools, ['read_file', 'write_file']);
  assert.strictEqual(child.killed, true, 'probe child is always terminated');
  assert.ok(child.written.includes('"method":"initialize"'));
  assert.ok(child.written.includes('"method":"tools/list"'));
  assert.strictEqual(child.spawnsWith.env.TOKEN, 'v', 'secret env reaches the probe child');
  assert.ok(child.written.includes('"protocolVersion"'));
});

test('probeStdio: timeout surfaces a readable reason and terminates the child', async () => {
  const child = fakeChild({ delay: 60_000 }); // never answers in time
  const r = await mc.probeStdio({
    command: 'fake', args: [], timeoutMs: 30,
    spawnImpl: () => { setTimeout(() => child.emit('spawn'), 0); return child; },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /timeout/);
  assert.strictEqual(child.killed, true);
});

test('probeStdio: spawn failure and early exit are classified', async () => {
  const r1 = await mc.probeStdio({
    command: 'x', timeoutMs: 500,
    spawnImpl: () => { throw new Error('ENOENT-ish'); },
  });
  assert.strictEqual(r1.ok, false);
  assert.match(r1.reason, /spawn failed/);
  const child = fakeChild({});
  const r2 = await mc.probeStdio({
    command: 'x', timeoutMs: 500,
    spawnImpl: () => { setTimeout(() => { child.emit('spawn'); child.emit('close', 1); }, 0); return child; },
  });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.reason, /exited/);
});

test('probeRemote: POST result is classified (ok / auth / network), fetch injectable', async () => {
  const ok = await mc.probeRemote('https://x/mcp', {}, 500, async () => ({ ok: true, status: 200, text: '{"jsonrpc":"2.0","id":1,"result":{}}' }));
  assert.strictEqual(ok.ok, true);
  const auth = await mc.probeRemote('https://x/mcp', {}, 500, async () => ({ ok: false, status: 401, text: '' }));
  assert.match(auth.reason, /auth/);
  const net = await mc.probeRemote('https://x/mcp', {}, 500, async () => { const e = new Error('no'); e.code = 'ECONNREFUSED'; throw e; });
  assert.strictEqual(net.reason, 'ECONNREFUSED');
});

test('whichCommand resolves an existing command and null for a missing one', async () => {
  const found = await mc.whichCommand(process.execPath); // node itself always exists
  assert.ok(found, 'node binary resolves');
  const missing = await mc.whichCommand('definitely-not-a-real-cmd-xyz-9137');
  assert.strictEqual(missing, null);
});

test('probeUrl classifies invalid urls and dead endpoints without throwing', async () => {
  const bad = await mc.probeUrl('not-a-url');
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /invalid url/);
  const dead = await mc.probeUrl('http://127.0.0.1:1/nope', 'HEAD', 500);
  assert.strictEqual(dead.ok, false);
});

test('createMcpConnect: tier2 results are cached for CACHE_TTL (second call spawns nothing)', async () => {
  let spawns = 0;
  const conn = mc.createMcpConnect({ log: () => {}, spawnImpl: () => { spawns += 1; return fakeChild({}); } });
  const server = { id: 's1', transport: 'stdio', command: 'fake', args: [], envSecretKeys: [], envPlain: {}, startupTimeoutSec: 3 };
  const r1 = await conn.tier2(server, () => null);
  assert.strictEqual(r1.ok, true);
  const r2 = await conn.tier2(server, () => null);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(spawns, 1, 'second probe served from the 5-minute cache');
  conn.clearCache('s1');
  await conn.tier2(server, () => null);
  assert.strictEqual(spawns, 2);
});

test('statusFor: healthy / error tiers map onto the UI vocabulary', () => {
  assert.strictEqual(mc.statusFor(null, { ok: true }), 'healthy');
  assert.match(mc.statusFor(null, { ok: false, reason: 'boom' }), /^error:boom/);
  assert.strictEqual(mc.statusFor({ ok: true, status: 'binaryFound' }, null), 'binaryFound');
  assert.strictEqual(mc.statusFor({ ok: false, status: 'commandNotFound' }, null), 'error:commandNotFound');
  assert.strictEqual(mc.statusFor(null, null), 'unknown');
});
