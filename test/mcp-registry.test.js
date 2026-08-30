// test/mcp-registry.test.js — discovery: builtin list + GitHub search (T1)
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const reg = require('../src/mcp-registry');

test('BUILTIN ships ≥12 verified entries plus a blank custom template, categories valid', () => {
  const real = reg.BUILTIN.filter((x) => x.id !== 'custom');
  assert.ok(real.length >= 12, `expected ≥12 builtin entries, got ${real.length}`);
  for (const it of real) {
    if (it.transport === 'stdio') {
      assert.ok(it.command, `${it.id}: builtin entries carry a real command (M-4 preview rule)`);
    } else {
      assert.ok(it.url || it.requiresConfig);
    }
    assert.ok(it.description && it.category && it.homepage, `${it.id}: description/category/homepage`);
  }
  const custom = reg.BUILTIN.find((x) => x.id === 'custom');
  assert.strictEqual(custom.command, '', 'custom template ships blank');
  assert.ok(reg.CATEGORIES.some(([k]) => k === 'all'));
});

test('search filters by query (name/description/id) and category', () => {
  const r = reg.createMcpRegistry({ log: () => {} });
  const gh = r.search('github');
  assert.ok(gh.some((x) => x.id === 'github'));
  const db = r.search('', 'database');
  assert.ok(db.length >= 2);
  assert.ok(db.every((x) => x.category === 'database'));
  assert.strictEqual(r.search('zzz-not-there', 'all').length, 0);
});

test('list merges online results after the builtin ones and de-duplicates by name', async () => {
  const r = reg.createMcpRegistry({
    log: () => {},
    fetchImpl: async (url) => {
      assert.ok(/topic%3Amcp-server|topic:mcp-server/.test(url), `search url hits the topic query: ${url}`);
      return {
        ok: true,
        json: async () => ({
          items: [
            { full_name: 'acme/fancy-mcp', name: 'fancy-mcp', description: 'does fancy things', stargazers_count: 42, html_url: 'https://github.com/acme/fancy-mcp' },
            { full_name: 'acme/github-dup', name: 'GitHub', description: 'dup', stargazers_count: 1, html_url: '' },
          ],
        }),
      };
    },
  });
  const items = await r.list('github', 'all');
  assert.ok(items.some((x) => x.id === 'github'), 'builtin entry survives the query filter');
  assert.ok(items.some((x) => x.id === 'gh-acme-fancy-mcp' && x.requiresConfig === true), 'online result merged');
  assert.strictEqual(items.filter((x) => x.name === 'GitHub').length, 1, 'builtin wins the name clash');
  assert.ok(items.findIndex((x) => x.id === 'github') < items.findIndex((x) => x.id === 'gh-acme-fancy-mcp'), 'builtin before online');
});

test('fromRegistryEntry maps official-registry entries onto executable shapes', () => {
  const npm = reg.fromRegistryEntry({
    name: 'io.github.acme/email-mcp', title: 'Email Integration', description: 'send emails',
    repository: { url: 'https://github.com/acme/email-mcp' },
    packages: [{ registryType: 'npm', identifier: '@acme/email-mcp', version: '1.0.0' }],
  });
  assert.strictEqual(npm.transport, 'stdio');
  assert.strictEqual(npm.command, 'npx');
  assert.deepStrictEqual(npm.args, ['-y', '@acme/email-mcp']);
  assert.strictEqual(npm.provider, 'community', 'io.github.* is registry-verified community');
  assert.strictEqual(npm.registryVerified, true);

  const pypi = reg.fromRegistryEntry({ name: 'io.modelcontextprotocol/time', packages: [{ registryType: 'pypi', identifier: 'mcp-server-time' }] });
  assert.strictEqual(pypi.command, 'uvx');
  assert.strictEqual(pypi.provider, 'official', 'io.modelcontextprotocol counts as official');

  const remote = reg.fromRegistryEntry({ name: 'com.example/gateway', remotes: [{ type: 'streamable-http', url: 'https://gw.example/mcp' }] });
  assert.strictEqual(remote.transport, 'sse');
  assert.strictEqual(remote.url, 'https://gw.example/mcp');

  // docker/nuget-only entries have no NPX/UVX shape → skipped
  assert.strictEqual(reg.fromRegistryEntry({ name: 'com.x/bin-only', packages: [{ registryType: 'docker', identifier: 'img' }] }), null);
  assert.strictEqual(reg.fromRegistryEntry(null), null);
});

test('list pulls the official registry even without a query; failures degrade to builtin', async () => {
  let registryHits = 0;
  const r = reg.createMcpRegistry({
    log: () => {},
    fetchImpl: async (url) => {
      if (String(url).includes('registry.modelcontextprotocol.io')) {
        registryHits += 1;
        return { ok: true, json: async () => ({ servers: [{ name: 'io.modelcontextprotocol/everything', title: 'Everything', description: 'official test server', packages: [{ registryType: 'npm', identifier: '@modelcontextprotocol/server-everything' }] }] }) };
      }
      return { ok: false, json: async () => ({}) };
    },
  });
  const items = await r.list('', 'all');
  assert.strictEqual(registryHits, 1, 'no-query visit still enriches from the official registry');
  assert.ok(items.some((x) => x.id === 'reg-everything'), 'registry entry merged');
  assert.ok(items.some((x) => x.id === 'filesystem'), 'builtin entry kept');
  // TTL cache: the second visit within 10 minutes must not re-fetch
  await r.list('', 'all');
  assert.strictEqual(registryHits, 1, 'official registry cached for REGISTRY_TTL_MS');
  // failure path: builtin still renders
  const offline = reg.createMcpRegistry({ log: () => {}, fetchImpl: async () => { throw new Error('down'); } });
  const fallback = await offline.list('', 'all');
  assert.ok(fallback.length >= 12, 'builtin baseline survives total network failure');
});

test('searchOnline fails silent to [] (offline stays usable); non-200 ignored', async () => {
  const r1 = reg.createMcpRegistry({ log: () => {}, fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepStrictEqual(await r1.searchOnline('github'), []);
  const r2 = reg.createMcpRegistry({ log: () => {}, fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
  assert.deepStrictEqual(await r2.searchOnline('github'), []);
  const r3 = reg.createMcpRegistry({ log: () => {}, fetchImpl: async () => ({ ok: true, json: async () => ({ items: [] }) }) });
  assert.deepStrictEqual(await r3.searchOnline(''), [], 'empty query skips the network entirely');
});
