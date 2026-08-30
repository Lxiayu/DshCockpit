// test/mcp-manager.test.js — MCP server panel (T1, v0.3.1)
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mm = require('../src/mcp-manager');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mcp-'));

function fakeSettings() {
  const store = { mcpServers: [] };
  return {
    get: () => ({ ...store }),
    patch: (p) => { Object.assign(store, p); return { ...store }; },
    _store: store,
  };
}

function makeManager({ dir = tmpDir(), platform = 'linux', verify } = {}) {
  const settings = fakeSettings();
  const logs = [];
  const mgr = mm.createMcpManager({
    settings,
    dshHome: () => dir,
    profileName: 'web',
    userDataDir: path.join(dir, 'userdata'),
    safeStorage: null, // tests: base64 'plain:' degradation, never silent plaintext
    log: (l) => logs.push(l),
    dumpConfigVerify: verify || (async () => ({ ok: true })),
    platform,
  });
  return { mgr, settings, dir, logs, patchFile: path.join(dir, 'profiles', 'web', 'cordis.patch.yml') };
}

const STDIO_SERVER = {
  id: 'filesystem', name: 'Filesystem', serverName: 'filesystem', transport: 'stdio',
  command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  envPlain: { NODE_ENV: 'production' }, envSecretKeys: ['GITHUB_TOKEN'],
};

// ------------------------------------------------------------ windows wrapping

test('wrapForWindows wraps npx-family commands on win32 only; unwrap reverses it', () => {
  const wrapped = mm.wrapForWindows('npx', ['-y', 'pkg'], 'win32');
  assert.deepStrictEqual(wrapped, { command: 'cmd', args: ['/c', 'npx', '-y', 'pkg'] });
  // npx.cmd / NPX case-insensitive
  assert.deepStrictEqual(mm.wrapForWindows('NPX.CMD', [], 'win32').command, 'cmd');
  // non-target commands untouched
  assert.deepStrictEqual(mm.wrapForWindows('serena', ['start'], 'win32'), { command: 'serena', args: ['start'] });
  assert.deepStrictEqual(mm.wrapForWindows('docker', ['run'], 'win32'), { command: 'docker', args: ['run'] });
  // other platforms untouched
  assert.deepStrictEqual(mm.wrapForWindows('npx', ['-y', 'pkg'], 'darwin'), { command: 'npx', args: ['-y', 'pkg'] });

  const unwrapped = mm.unwrapForWindows('cmd', ['/c', 'npx', '-y', 'pkg'], 'win32');
  assert.deepStrictEqual(unwrapped, { command: 'npx', args: ['-y', 'pkg'] });
  // round-trip
  const w = mm.wrapForWindows('npx', ['-y', 'pkg'], 'win32');
  assert.deepStrictEqual(mm.unwrapForWindows(w.command, w.args, 'win32'), { command: 'npx', args: ['-y', 'pkg'] });
  // a real `cmd` command the user wants is left alone by unwrap when not /c-shaped
  assert.deepStrictEqual(mm.unwrapForWindows('cmd', ['/k', 'x'], 'win32'), { command: 'cmd', args: ['/k', 'x'] });
});

// ---------------------------------------------------------- patch file surgery

const FOREIGN_PATCH = [
  '# my hand-written patch',
  '- insert:',
  '    - id: my-custom-bundle',
  "      name: '@acme/some-plugin'",
  '      config:',
  '        enabled: true',
  '',
  '# trailing comment',
].join('\n');

test('scanPatchItems finds block ids in a mixed file (comments + foreign block survive)', () => {
  const scan = mm.scanPatchItems(FOREIGN_PATCH.split('\n'));
  assert.ok(scan, 'insert section found');
  assert.strictEqual(scan.items.length, 1);
  assert.strictEqual(scan.items[0].id, 'my-custom-bundle');
  // empty / absent insert sections
  assert.strictEqual(mm.scanPatchItems(''.split('\n')), null);
  assert.strictEqual(mm.scanPatchItems(['- remove:', '  x: 1'].join('\n')), null);
});

test('upsertPatchBlock creates the insert section on an empty file and appends to an existing list', () => {
  const block = ['    - id: mcp-fs', "      name: '@deepseek-ai/dsh-mcp-client'", '      config:', '        serverName: fs'];
  const created = mm.upsertPatchBlock('', 'mcp-fs', block);
  assert.match(created, /^- insert:\n    - id: mcp-fs/);
  // appending after a foreign block keeps its bytes and position
  const block2 = ['    - id: mcp-gh', '      config:', '        serverName: gh'];
  const appended = mm.upsertPatchBlock(FOREIGN_PATCH, 'mcp-gh', block2);
  assert.ok(appended.includes('- id: my-custom-bundle'), 'foreign block kept');
  assert.ok(appended.includes('# my hand-written patch'), 'header comment kept');
  assert.ok(appended.includes('# trailing comment'), 'trailing comment kept');
  const scan = mm.scanPatchItems(appended.split('\n'));
  assert.strictEqual(scan.items.length, 2);
  assert.strictEqual(scan.items[1].id, 'mcp-gh');
  // replaced in place, same length structure
  const replaced = mm.upsertPatchBlock(appended, 'mcp-gh', ['    - id: mcp-gh', '      config:', '        serverName: gh2']);
  assert.ok(replaced.includes('serverName: gh2'));
  assert.ok(!replaced.includes('serverName: gh\n'));
});

test('removePatchBlock drops the block and collapses an emptied insert section', () => {
  const block1 = ['    - id: mcp-a', '      config:', '        serverName: a'];
  const block2 = ['    - id: mcp-b', '      config:', '        serverName: b'];
  let text = mm.upsertPatchBlock('', 'mcp-a', block1);
  text = mm.upsertPatchBlock(text, 'mcp-b', block2);
  const afterA = mm.removePatchBlock(text, 'mcp-a');
  assert.ok(!afterA.includes('serverName: a'));
  assert.ok(afterA.includes('serverName: b'));
  // removing the last one collapses `- insert:` entirely
  const afterB = mm.removePatchBlock(afterA, 'mcp-b');
  assert.ok(!afterB.includes('- insert:'), 'empty insert section collapses');
  assert.strictEqual(mm.removePatchBlock(afterB, 'mcp-b'), afterB, 'noop when absent');
});

// ---------------------------------------------------------------- validation

test('sanitizeServer validates ids, namespaces, duplicate namespace, command and url', () => {
  const existing = [{ id: 'other', serverName: 'taken' }];
  assert.match(mm.sanitizeServer({ id: 'Bad_ID', name: 'x', serverName: 'x', transport: 'stdio', command: 'n' }, null, existing).err, /invalid id/);
  assert.match(mm.sanitizeServer({ id: 'ok', name: 'x', serverName: 'TAKEN', transport: 'stdio', command: 'n' }, null, existing).err, /namespace/);
  assert.match(mm.sanitizeServer({ id: 'ok', name: 'x', serverName: 'fresh', transport: 'stdio' }, null, existing).err, /missing command/);
  assert.match(mm.sanitizeServer({ id: 'ok', name: 'x', serverName: 'fresh', transport: 'sse' }, null, existing).err, /invalid url/);
  assert.match(mm.sanitizeServer({ id: 'ok', name: 'x', serverName: 'fresh', transport: 'carrier-pigeon', command: 'n' }, null, existing).err, /invalid transport/);
  assert.match(mm.sanitizeServer({ id: 'ok', name: 'x', serverName: 'fresh', transport: 'stdio', command: 'n', envPlain: { 'BAD KEY': 'v' } }, null, existing).err, /invalid env key/);
  const ok = mm.sanitizeServer({ ...STDIO_SERVER }, null, existing);
  assert.ok(ok.server);
  assert.ok(!ok.server.envPlain.GITHUB_TOKEN, 'secret keys are stripped from envPlain');
});

// ------------------------------------------------------------- manager flows

test('save writes the patch block and the settings record; secrets never touch any file', async () => {
  const { mgr, settings, patchFile } = makeManager();
  const r = await mgr.save({ ...STDIO_SERVER }, { GITHUB_TOKEN: 'ghp_super_secret_value' });
  assert.strictEqual(r.ok, true);
  const patchText = fs.readFileSync(patchFile, 'utf8');
  assert.ok(patchText.includes('serverName: "filesystem"') || patchText.includes('serverName: filesystem'));
  assert.ok(!patchText.includes('ghp_super_secret_value'), 'secret must not reach cordis.patch.yml');
  assert.ok(!patchText.includes('GITHUB_TOKEN'), 'secret env key stays out of the block entirely');
  assert.ok(!JSON.stringify(settings._store).includes('ghp_super_secret_value'), 'secret must not reach settings.json');
  const snap = mgr.listServers();
  assert.strictEqual(snap.servers.length, 1);
  assert.deepStrictEqual(snap.servers[0].envSecrets, { GITHUB_TOKEN: { configured: true } });
  assert.strictEqual(snap.patchBlockIds.includes('mcp-filesystem'), true);
  assert.ok(mgr.resolveSecret('filesystem', 'GITHUB_TOKEN') === null || typeof mgr.resolveSecret('filesystem', 'GITHUB_TOKEN') === 'string');
});

test('save on win32 wraps the command in the file while the record keeps the raw form', async () => {
  const { mgr, patchFile } = makeManager({ platform: 'win32' });
  await mgr.save({ ...STDIO_SERVER }, {});
  const text = fs.readFileSync(patchFile, 'utf8');
  assert.ok(text.includes('command: "cmd"'), 'wrapped command in the truth layer');
  assert.ok(text.includes('- "/c"') || text.includes("'/c'"), 'cmd /c in args');
  const rec = mgr.getServer('filesystem').server;
  assert.strictEqual(rec.command, 'npx', 'intent layer keeps the raw command');
  assert.deepStrictEqual(rec.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
});

test('toggle off removes the block but keeps the record; toggle on restores it with the secret intact', async () => {
  const { mgr } = makeManager();
  await mgr.save({ ...STDIO_SERVER }, { GITHUB_TOKEN: 'ghp_keep_me' });
  assert.strictEqual((await mgr.toggle('filesystem', false)).ok, true);
  let snap = mgr.listServers();
  assert.strictEqual(snap.servers.length, 1, 'record kept (enabled:false)');
  assert.strictEqual(snap.servers[0].enabled, false);
  assert.strictEqual(snap.patchBlockIds.includes('mcp-filesystem'), false, 'block removed from truth layer');
  // noop toggle returns ok
  assert.strictEqual((await mgr.toggle('filesystem', false)).noop, true);
  await mgr.toggle('filesystem', true);
  snap = mgr.listServers();
  assert.strictEqual(snap.patchBlockIds.includes('mcp-filesystem'), true, 'block restored');
  assert.strictEqual(mgr.resolveSecret('filesystem', 'GITHUB_TOKEN'), 'ghp_keep_me', 'secret survived the cycle');
});

test('remove cleans the block, the record and every vault entry', async () => {
  const { mgr } = makeManager();
  await mgr.save({ ...STDIO_SERVER }, { GITHUB_TOKEN: 'ghp_bye' });
  assert.strictEqual((await mgr.remove('filesystem')).ok, true);
  const snap = mgr.listServers();
  assert.strictEqual(snap.servers.length, 0);
  assert.strictEqual(snap.patchBlockIds.includes('mcp-filesystem'), false);
  assert.strictEqual(mgr.resolveSecret('filesystem', 'GITHUB_TOKEN'), null);
  assert.strictEqual((await mgr.remove('nope')).ok, false);
});

test('a rejected dump-config rolls the patch file back byte-for-byte', async () => {
  const dir = tmpDir();
  let verdict = { ok: true };
  const { mgr, patchFile } = makeManager({ dir, verify: async () => verdict });
  // seed a good write + foreign content
  await mgr.save({ ...STDIO_SERVER }, {});
  const goodText = fs.readFileSync(patchFile, 'utf8');
  // now make verification fail for the next write
  verdict = { ok: false, reason: 'dump-config exit 1' };
  const bad = await mgr.save({ ...STDIO_SERVER, id: 'broken', serverName: 'broken', name: 'Broken', command: 'nope-cmd' }, {});
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /dump-config exit 1/);
  assert.strictEqual(fs.readFileSync(patchFile, 'utf8'), goodText, 'file rolled back to the exact pre-write bytes');
  assert.strictEqual(mgr.listServers().servers.length, 1, 'settings untouched on failure');
  // and with no prior file: the failed write leaves no file behind
  const dir2 = tmpDir();
  const second = makeManager({ dir: dir2, verify: async () => ({ ok: false, reason: 'x' }) });
  const r2 = await second.mgr.save({ ...STDIO_SERVER, id: 'gone', serverName: 'gone', name: 'Gone', command: 'x' }, {});
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(fs.existsSync(path.join(dir2, 'profiles', 'web', 'cordis.patch.yml')), false, 'no file when there was none before');
});

test('runtimeSecretEnv aggregates enabled servers only; collisions last-wins with a log line', async () => {
  const { mgr, logs } = makeManager();
  await mgr.save({ ...STDIO_SERVER }, { GITHUB_TOKEN: 'sk-1' });
  await mgr.save({
    id: 'brave', name: 'Brave', serverName: 'brave', transport: 'stdio',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envPlain: {}, envSecretKeys: ['GITHUB_TOKEN', 'BRAVE_API_KEY'], enabled: false,
  }, { GITHUB_TOKEN: 'sk-2', BRAVE_API_KEY: 'brv-1' });
  const env = mgr.runtimeSecretEnv();
  assert.strictEqual(env.GITHUB_TOKEN, 'sk-1', 'disabled server contributes nothing');
  assert.strictEqual(env.BRAVE_API_KEY, undefined, 'disabled server secret omitted');
  await mgr.toggle('brave', true);
  const env2 = mgr.runtimeSecretEnv();
  assert.strictEqual(env2.GITHUB_TOKEN, 'sk-2', 'last enabled server wins');
  assert.strictEqual(env2.BRAVE_API_KEY, 'brv-1');
  assert.ok(logs.some((l) => l.includes('multiple servers')), 'collision logged once');
});

test('remote transports persist url + headers literally (documented limitation), env secrets still vaulted', async () => {
  const { mgr, patchFile } = makeManager();
  const r = await mgr.save({
    id: 'notion', name: 'Notion', serverName: 'notion', transport: 'sse',
    url: 'https://mcp.notion.com/mcp',
    headers: { Authorization: 'Bearer ntn_secret' },
    envSecretKeys: [],
  }, {});
  assert.strictEqual(r.ok, true);
  const text = fs.readFileSync(patchFile, 'utf8');
  assert.ok(text.includes('transport: "sse"') || text.includes('transport: sse'));
  assert.ok(text.includes('https://mcp.notion.com/mcp'));
  assert.ok(text.includes('Bearer ntn_secret'), 'header value is literal by design (UI warns)');
  // websocket type round-trips
  await mgr.save({ id: 'ws1', name: 'WS', serverName: 'ws1', transport: 'websocket', url: 'wss://x/y' }, {});
  assert.strictEqual(mgr.getServer('ws1').server.transport, 'websocket');
});

// ------------------------------------------------- center routing guard (UI reachability)
//
// Regression guard for the "feature exists but is unreachable" class of bug:
// every cockpit quick-action (except the locally-handled ones) must be
// routable through window-manager.cockpitNavigate's allowlist AND visible in
// the settings window's CONTROL_PAGES set. MCP was shipped once with the page
// implemented but missing from both — the button silently hid itself.

test('center routing guard: cockpit quick actions ↔ cockpitNavigate ↔ CONTROL_PAGES stay in sync', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
  const cockpit = read('cockpit.html');
  const actions = [...cockpit.matchAll(/data-action="([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(actions.includes('mcp'), 'cockpit ships the MCP quick action');
  // handled locally in cockpit.html's click handler — never routed to the center
  const localOnly = new Set(['quickask', 'search', 'tasks']);
  const routed = actions.filter((a) => !localOnly.has(a));

  const wm = read('window-manager.js');
  const controlMatch = wm.match(/control: \[([^\]]+)\]/);
  assert.ok(controlMatch, 'cockpitNavigate control allowlist found');
  const wmControl = (controlMatch[1].match(/'([a-z]+)'/g) || []).map((s) => s.replaceAll("'", ''));

  const settingsHtml = read('settings.html');
  const pagesMatch = settingsHtml.match(/const CONTROL_PAGES = new Set\(\[([^\]]+)\]\)/);
  assert.ok(pagesMatch, 'settings.html CONTROL_PAGES set found');
  const controlPages = (pagesMatch[1].match(/'([a-z]+)'/g) || []).map((s) => s.replaceAll("'", ''));

  for (const page of routed) {
    assert.ok(wmControl.includes(page), `cockpit action "${page}" must be in cockpitNavigate allowed.control`);
    assert.ok(controlPages.includes(page), `cockpit action "${page}" must be in settings.html CONTROL_PAGES`);
    // the nav entry itself must exist so the page is actually clickable
    assert.ok(settingsHtml.includes(`data-page="${page}"`), `settings.html must ship a data-page="${page}" nav item`);
  }
});
