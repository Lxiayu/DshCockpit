// test/mcp-import.test.js — universal MCP config importer (T1, v0.3.1)
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const mi = require('../src/mcp-import');

test('extractMap understands every wrapper shape (mcpServers / mcp.servers / servers)', () => {
  assert.strictEqual(Object.keys(mi.extractMap({ mcpServers: { a: {} } }))[0], 'a');
  assert.strictEqual(Object.keys(mi.extractMap({ mcp: { servers: { b: {} } } }))[0], 'b');
  assert.strictEqual(Object.keys(mi.extractMap({ servers: { c: {} } }))[0], 'c');
  assert.strictEqual(mi.extractMap(null), null);
  assert.strictEqual(mi.extractMap('x'), null);
  assert.strictEqual(mi.extractMap({ command: 'npx' }), null, 'single-server objects are handled in prepare, not extractMap');
});

test('normalizeEntry: stdio entries keep command/args and route every env value to the vault', () => {
  const n = mi.normalizeEntry('GitHub', {
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: 'ghp_x', NODE_ENV: 'production' },
  });
  assert.strictEqual(n.err, undefined);
  assert.strictEqual(n.server.transport, 'stdio');
  assert.strictEqual(n.server.command, 'npx');
  assert.strictEqual(n.server.serverName, 'github');
  assert.deepStrictEqual(n.secrets, { GITHUB_TOKEN: 'ghp_x', NODE_ENV: 'production' }, 'imported values are untrusted → all vaulted');
  assert.deepStrictEqual(n.server.envSecretKeys, ['GITHUB_TOKEN', 'NODE_ENV']);
  assert.strictEqual(n.server.envPlain.GITHUB_TOKEN, undefined);
});

test('normalizeEntry: remote url → sse (http/streamable), websocket preserved; entry without command+url rejected', () => {
  const sse = mi.normalizeEntry('Notion', { type: 'http', url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer x' } });
  assert.strictEqual(sse.server.transport, 'sse');
  assert.strictEqual(sse.server.url, 'https://mcp.notion.com/mcp');
  assert.strictEqual(sse.server.headers.Authorization, 'Bearer x');
  const ws = mi.normalizeEntry('Push', { type: 'websocket', url: 'wss://x/y' });
  assert.strictEqual(ws.server.transport, 'websocket');
  assert.match(mi.normalizeEntry('Broken', {}).err, /neither command nor url/);
});

test('prepare resolves id name conflicts with _1 suffixes (claude-code import behaviour)', () => {
  const imp = mi.createMcpImport({});
  const r = imp.prepare('clipboard', null, JSON.stringify({
    mcpServers: {
      github: { command: 'npx', args: [] },
      github: { command: 'npx', args: [] }, // duplicate key collapses in JSON — use two names instead
    },
  }), ['mcp-github']);
  // duplicate JSON keys collapse, so exercise the conflict path via existingIds
  const r2 = imp.prepare('clipboard', null, JSON.stringify({
    mcpServers: { github: { command: 'npx' }, 'GitHub': { url: 'https://x/mcp' } },
  }), ['mcp-github']);
  assert.strictEqual(r2.ok, true);
  const ids = r2.items.filter((x) => !x.error).map((x) => x.server.id);
  assert.ok(ids.includes('github_1'), `conflict suffixed: ${ids.join(',')}`);
});

test('prepare: clipboard accepts a single server object and rejects invalid JSON', () => {
  const imp = mi.createMcpImport({});
  const single = imp.prepare('clipboard', null, JSON.stringify({ command: 'npx', args: ['-y', 'pkg'] }), []);
  assert.strictEqual(single.ok, true);
  assert.strictEqual(single.items[0].server.command, 'npx');
  const bad = imp.prepare('clipboard', null, '{nope', []);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /invalid JSON/);
});

test('prepare: entries without a command/url become per-item errors, siblings still import', () => {
  const imp = mi.createMcpImport({});
  const r = imp.prepare('clipboard', null, JSON.stringify({
    mcpServers: { good: { command: 'npx' }, bad: { env: {} } },
  }), []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.items.find((x) => x.error).name, 'bad');
  assert.strictEqual(r.items.find((x) => x.server).server.id, 'good', 'ids are unprefixed slugs (the patch layer adds mcp-)');
});

test('parsePastedJson tolerates Trae-style // comment lines and trailing commas', () => {
  const annotated = [
    '// 示例：',
    '// {',
    '//   "mcpServers": {',
    '//     "example-server": {',
    '//       "command": "npx",',
    '//       "args": [',
    '//         "-y",',
    '//         "mcp-server-example"',
    '//       ]',
    '//     },',
    '//   },',
    '// }',
  ].join('\n');
  const parsed = mi.parsePastedJson(annotated);
  assert.strictEqual(parsed.mcpServers['example-server'].command, 'npx');
  // trailing commas (common in hand-edited JSON) survive too
  const trailing = '{ "mcpServers": { "a": { "command": "npx", "args": ["-y",], } } }';
  assert.strictEqual(mi.parsePastedJson(trailing).mcpServers.a.command, 'npx');
  // plain JSON still parses
  assert.strictEqual(mi.parsePastedJson('{"a":1}').a, 1);
  // genuinely broken JSON still throws
  assert.throws(() => mi.parsePastedJson('{nope'));
});

test('scanSources probes the real filesystem and never throws (absent files → count 0)', () => {
  const imp = mi.createMcpImport({ log: () => {} });
  const sources = imp.scanSources();
  assert.ok(Array.isArray(sources) && sources.length >= 3);
  for (const s of sources) {
    assert.ok(s.key && s.label);
    assert.ok(Array.isArray(s.servers));
    assert.strictEqual(typeof s.count, 'number');
  }
});
