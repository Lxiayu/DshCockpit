// test/mcp-usage.test.js — MCP usage observability from session logs (T1)
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mu = require('../src/mcp-usage');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mcpu-'));

test('scanChunk: raw-line regex counts mcp__server__tool without JSON.parse on quiet lines', () => {
  const stats = { servers: {}, lastMs: 0, capped: false };
  mu.scanChunk([
    JSON.stringify({ timestamp: '2026-08-29T10:00:00Z', event: 'tool', name: 'mcp__filesystem__read_file' }),
    JSON.stringify({ ts: 1756464000, name: 'mcp__filesystem__read_file' }), // seconds → ms
    JSON.stringify({ name: 'mcp__github__create_issue' }),
    'not json at all but mentions mcp__serena__find_symbol',
    JSON.stringify({ quiet: true }),
  ].join('\n'), stats);
  assert.ok(stats.servers.filesystem.toolCalls === 2);
  assert.strictEqual(stats.servers.filesystem.tools.read_file, 2);
  assert.strictEqual(stats.servers.github.toolCalls, 1);
  assert.strictEqual(stats.servers.serena.toolCalls, 1, 'non-JSON lines still count');
  assert.strictEqual(stats.lastMs, Date.parse('2026-08-29T10:00:00Z'), 'ISO timestamp parsed to ms');
  assert.ok(!stats.servers.quiet);
});

test('scanChunk: a line with mcp__ tokens whose shape defeats the regex counts once as unknown', () => {
  const stats = { servers: {}, lastMs: 0, capped: false };
  mu.scanChunk('mcp__ inside a prose sentence, no valid tool name', stats);
  assert.strictEqual(stats.servers.unknown.toolCalls, 1);
});

function writeSession(root, proj, ses, lines) {
  const dir = path.join(root, 'sessions', proj, ses);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), lines.join('\n') + '\n');
  return path.join(dir, 'session.jsonl');
}

test('collect walks DSH_HOME/sessions, aggregates per server, and the incremental cache keeps the second run consistent', async () => {
  mu.resetCache();
  const root = tmpDir();
  writeSession(root, 'proj-a', 's1', [
    JSON.stringify({ timestamp: '2026-08-29T09:00:00Z', name: 'mcp__filesystem__read_file' }),
    JSON.stringify({ name: 'mcp__filesystem__list_directory' }),
  ]);
  writeSession(root, 'proj-b', 's2', [
    JSON.stringify({ name: 'mcp__github__create_issue' }),
  ]);
  // zstd file preferred over plain when both exist — a decode failure skips
  // the session entirely (never crashes, never half-counts)
  fs.writeFileSync(path.join(root, 'sessions', 'proj-b', 's2', 'session.jsonl.zstd'), 'not really zstd');
  const u1 = await mu.collect(root, { decode: async () => null });
  assert.strictEqual(u1.servers.filesystem.toolCalls, 2);
  assert.strictEqual(u1.servers.github, undefined, 'zstd-shadowed session with failing decode is skipped wholesale');
  assert.strictEqual(u1.totalFiles, 2, 'one entry per session dir (zstd wins over plain)');
  // second collect: cache hit path returns the same numbers (no double count)
  const u2 = await mu.collect(root, { decode: async () => null });
  assert.strictEqual(u2.servers.filesystem.toolCalls, 2);
  assert.strictEqual(u2.servers.github, undefined);
  assert.strictEqual(u2.totalFiles, 2);
  // appending grows the file; the incremental path picks up only new lines
  fs.appendFileSync(path.join(root, 'sessions', 'proj-a', 's1', 'session.jsonl'), JSON.stringify({ name: 'mcp__filesystem__write_file' }) + '\n');
  const u3 = await mu.collect(root, { decode: async () => null });
  assert.strictEqual(u3.servers.filesystem.toolCalls, 3);
  assert.ok(u3.servers.filesystem.topTools.some((t) => t.tool === 'write_file' && t.count === 1), 'incremental pass picked up the appended line');
});

test('collect caps the file count and reports it (huge histories stay bounded)', async () => {
  mu.resetCache();
  const root = tmpDir();
  for (let i = 0; i < 6; i++) {
    writeSession(root, `p${i}`, 's', [JSON.stringify({ name: `mcp__srv${i}__tool` })]);
  }
  const u = await mu.collect(root, { maxFiles: 3, decode: async () => null });
  assert.strictEqual(u.scannedFiles, 3);
  assert.strictEqual(u.capped, true);
  assert.strictEqual(Object.keys(u.servers).length, 3);
});

test('collect on a missing/empty DSH_HOME returns a shaped empty result', async () => {
  mu.resetCache();
  const u = await mu.collect(path.join(tmpDir(), 'nope'), {});
  assert.deepStrictEqual(u, { servers: {}, lastUsedAt: null, scannedFiles: 0, totalFiles: 0, capped: false });
});
