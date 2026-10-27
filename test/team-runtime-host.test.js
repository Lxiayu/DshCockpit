'use strict';

// test/team-runtime-host.test.js — v0.7 P2：工作区专用 dsh runtime 的启动/复用/切换/停止。
// 完全注入：不启动真实进程、不连网络。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTeamRuntimeHost } = require('../src/team-runtime-host.js');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal) => { child.killed = signal || true; child.emit('exit', null, signal || 'SIGTERM'); };
  return child;
}

function setup(overrides = {}) {
  const events = { spawns: [], muxes: [], rpcs: [], kills: 0 };
  const children = [];
  const spawnImpl = (bin, args, options) => {
    const child = fakeChild();
    child.pid = 5000 + children.length;
    const originalKill = child.kill;
    child.kill = (signal) => { events.kills += 1; originalKill(signal); };
    events.spawns.push({ bin, args, options, child });
    children.push(child);
    return child;
  };
  const host = createTeamRuntimeHost({
    dshBin: () => '/abs/bin.js',
    nodeBin: () => ({ bin: '/abs/node' }),
    dshHome: () => '/abs/home/.dsh',
    envExtras: () => ({ EXTRA_SECRET: 'x' }),
    log: () => {},
    armWatchdogImpl: (args) => { events.watchdog = args; },
    spawnImpl,
    healthImpl: async () => true,
    createAuth: () => ({ setAuthUrl: (u) => { events.authUrl = u; } }),
    createMux: (deps) => { events.muxes.push(deps); return { connect: () => { events.muxConnected = (events.muxConnected || 0) + 1; }, close: () => { events.muxClosed = (events.muxClosed || 0) + 1; } }; },
    createRpc: (origin, deps) => { events.rpcs.push({ origin, deps }); return { rpc: true }; },
    startTimeoutMs: 500,
    idleStopMs: 30,
    ...overrides,
  });
  return { host, events, children, workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'team-rt-')) };
}

function emitUrl(child, url = 'http://127.0.0.1:5555/?token=abc') {
  child.stdout.write(`dsh web: ${url}\n`);
}

test('team-runtime: spawns a workspace-rooted web runtime and builds its own rpc/mux', async () => {
  const { host, events, children, workspace } = setup();
  const pending = host.ensure(workspace);
  // wait until the spawn happened, then print the URL line
  await new Promise((r) => setTimeout(r, 5));
  emitUrl(children[0]);
  const rt = await pending;
  assert.equal(events.spawns.length, 1);
  const spawn = events.spawns[0];
  assert.equal(spawn.bin, '/abs/node');
  assert.deepEqual(spawn.args, ['/abs/bin.js', '--profile', 'web', '--port', '0', '--no-open']);
  assert.equal(spawn.options.cwd, workspace);
  assert.equal(spawn.options.env.DSH_HOME, '/abs/home/.dsh');
  assert.equal(spawn.options.env.EXTRA_SECRET, 'x');
  assert.deepEqual(rt.origin, 'http://127.0.0.1:5555');
  assert.equal(events.authUrl, 'http://127.0.0.1:5555/?token=abc');
  assert.equal(events.muxes[0].baseUrl, 'http://127.0.0.1:5555');
  assert.equal(events.muxConnected, 1, 'the team mux is connected explicitly');
  assert.equal(events.watchdog.runtimePid, 5000, 'a watchdog is armed for the team runtime');
  assert.equal(events.rpcs[0].origin, 'http://127.0.0.1:5555');
  assert.equal(events.rpcs[0].deps.protocol, 'slash');
  assert.equal(rt.rpc.rpc, true);
  host.stop();
  assert.ok(events.kills >= 1);
});

test('team-runtime: same workspace reuses the process; a different workspace stops it first', async () => {
  const { host, events, children, workspace } = setup();
  const first = host.ensure(workspace);
  await new Promise((r) => setTimeout(r, 5));
  emitUrl(children[0], 'http://127.0.0.1:6001/?token=a');
  await first;
  const again = await host.ensure(workspace);
  assert.equal(again.origin, 'http://127.0.0.1:6001');
  assert.equal(events.spawns.length, 1, 'no second process for the same workspace');

  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'team-rt-other-'));
  const third = host.ensure(other);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(events.kills, 1, 'switching workspaces stops the old runtime');
  emitUrl(children[1], 'http://127.0.0.1:6002/?token=b');
  const rt = await third;
  assert.equal(rt.origin, 'http://127.0.0.1:6002');
  assert.equal(events.spawns.length, 2);
  assert.equal(events.spawns[1].options.cwd, other);
  host.stop();
});

test('team-runtime: an exit before the URL line fails closed with a stable code', async () => {
  const { host, children, workspace } = setup();
  const pending = host.ensure(workspace);
  await new Promise((r) => setTimeout(r, 5));
  children[0].emit('exit', 1, null);
  await assert.rejects(pending, /TEAM_RUNTIME_EXITED/);
  assert.equal(host.status().ready, false);
});

test('team-runtime: an unhealthy probe stops the process and rejects', async () => {
  let killed = 0;
  const { host, events, children, workspace } = setup({ healthImpl: async () => false });
  const pending = host.ensure(workspace);
  await new Promise((r) => setTimeout(r, 5));
  emitUrl(children[0]);
  await assert.rejects(pending, /TEAM_RUNTIME_UNHEALTHY/);
  assert.ok(events.kills >= 1);
  void killed;
});

test('team-runtime: idle stop reaps the runtime after the work item settles', async () => {
  const { host, events, children, workspace } = setup({ idleStopMs: 25 });
  const pending = host.ensure(workspace);
  await new Promise((r) => setTimeout(r, 5));
  emitUrl(children[0]);
  await pending;
  host.scheduleIdleStop();
  assert.equal(host.status().ready, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(host.status().ready, false);
  assert.ok(events.kills >= 1, 'the idle runtime is stopped');
  assert.ok(events.muxClosed >= 1, 'its mux is closed');
});
