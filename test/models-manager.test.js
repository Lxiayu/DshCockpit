// test/models-manager.test.js — model provider panel + Ollama (C2, v0.2.4)
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mm = require('../src/models-manager');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-models-'));

// ------------------------------------------------------------ preset templates

test('preset templates: ≥6 vendors with https baseURL, valid credential refs, plus custom + ollama', () => {
  const vendors = mm.PRESETS.filter((p) => p.id !== 'custom');
  assert.ok(vendors.length >= 6, `expected ≥6 vendor presets, got ${vendors.length}`);
  const ids = new Set();
  for (const p of vendors) {
    assert.ok(/^[a-z][a-z0-9-]*$/.test(p.id), `${p.id}: route-id shape`);
    assert.match(p.baseURL, /^https:\/\/.+/, `${p.id}: baseURL must be https`);
    assert.match(p.keyEnv, /^[A-Z][A-Z0-9_]*$/, `${p.id}: keyEnv must be a credential ref`);
    assert.match(p.portalUrl, /^https:\/\//, `${p.id}: portalUrl`);
    assert.match(p.docsUrl, /^https:\/\//, `${p.id}: docsUrl`);
    assert.ok(p.nameKey, `${p.id}: nameKey required`);
    ids.add(p.id);
  }
  const custom = mm.PRESETS.find((p) => p.id === 'custom');
  assert.ok(custom && custom.baseURL === '' && custom.keyEnv === '', 'custom preset ships blank');
  assert.strictEqual(mm.OLLAMA_PRESET.ollama, true);
  assert.strictEqual(mm.OLLAMA_PRESET.baseURL, 'http://localhost:11434/v1');
  assert.strictEqual(mm.OLLAMA_PRESET.keyEnv, 'OLLAMA_API_KEY');
  assert.strictEqual(mm.OLLAMA_KEY, 'ollama'); // required-but-ignored by Ollama's OpenAI layer
});

// -------------------------------------------------- credentials line-level I/O

test('upsertCredential/readCredential/removeCredential are line-level: foreign keys, comments and order survive', () => {
  const before = [
    '# managed by DshCockpit — other lines must keep their exact position',
    'DEEPSEEK_API_KEY: sk-keep-1',
    '',
    '# a comment in the middle',
    'GITHUB_TOKEN: "ghp_keep"',
  ].join('\n');
  const afterAdd = mm.upsertCredential(before, 'SILICONFLOW_API_KEY', 'sk-new');
  assert.match(afterAdd, /^SILICONFLOW_API_KEY: sk-new$/m);
  // every pre-existing line still present, in order, untouched
  const beforeLines = before.split('\n');
  const afterLines = afterAdd.split('\n');
  assert.deepStrictEqual(afterLines.slice(0, beforeLines.length), beforeLines);
  assert.strictEqual(mm.readCredential(afterAdd, 'SILICONFLOW_API_KEY'), 'sk-new');
  assert.strictEqual(mm.readCredential(afterAdd, 'DEEPSEEK_API_KEY'), 'sk-keep-1');

  // update-in-place replaces only that line
  const afterUpd = mm.upsertCredential(afterAdd, 'SILICONFLOW_API_KEY', 'sk-rotated');
  assert.strictEqual(mm.readCredential(afterUpd, 'SILICONFLOW_API_KEY'), 'sk-rotated');
  assert.strictEqual(mm.readCredential(afterUpd, 'DEEPSEEK_API_KEY'), 'sk-keep-1');
  assert.strictEqual(afterUpd.split('\n').length, afterAdd.split('\n').length);

  // quoted values are unquoted on read
  assert.strictEqual(mm.readCredential('MOONSHOT_API_KEY: "sk-q"\n', 'MOONSHOT_API_KEY'), 'sk-q');

  // remove drops exactly the one line
  const afterRm = mm.removeCredential(afterUpd, 'SILICONFLOW_API_KEY');
  assert.strictEqual(mm.readCredential(afterRm, 'SILICONFLOW_API_KEY'), null);
  assert.strictEqual(mm.readCredential(afterRm, 'GITHUB_TOKEN'), 'ghp_keep');
  assert.ok(afterRm.includes('# a comment in the middle'));
  // absent ref: all ops are noops
  assert.strictEqual(mm.removeCredential(afterRm, 'NOPE_KEY'), afterRm);
  assert.strictEqual(mm.upsertCredential('', 'A_B', 'v'), 'A_B: v\n');
});

test('writeCredentialsFile writes 0600 atomically (no .tmp residue, other files untouched)', () => {
  const dir = tmpDir();
  const file = path.join(dir, '.credentials.yaml');
  mm.writeCredentialsFile(file, 'DEEPSEEK_API_KEY: sk-x\n');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'DEEPSEEK_API_KEY: sk-x\n');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'credentials must be 0600 on POSIX');
  assert.ok(!fs.existsSync(`${file}.tmp`), 'tmp file must be renamed away');
  // rewrite keeps the mode even after a chmod-widening writer elsewhere
  fs.chmodSync(file, 0o644);
  mm.writeCredentialsFile(file, 'DEEPSEEK_API_KEY: sk-y\n');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

// ------------------------------------------------ settings.yaml section edits

test('agent-default-model: upsertSection writes the runtime schema, other namespaces keep their lines', () => {
  const before = [
    '# dsh settings',
    'theme: dark',
    'agent-default-model:',
    '  provider: "deepseek"',
    '  model: "deepseek-chat"',
    '  reasoningEffort: "high"',
    'channels: {}',
  ].join('\n');
  const after = mm.upsertSection(before, 'agent-default-model', [
    '  provider: "siliconflow"',
    '  model: "Qwen/Qwen3-8B"',
  ]);
  // section replaced in place; header comment, theme and channels untouched
  assert.ok(after.includes('# dsh settings'));
  assert.ok(after.includes('theme: dark'));
  assert.ok(after.includes('channels: {}'));
  assert.ok(!after.includes('deepseek-chat'));
  assert.ok(!after.includes('reasoningEffort'), 'omitted when falsy');

  const parsed = mm.parseAgentDefaultModel(after);
  assert.deepStrictEqual(parsed, { provider: 'siliconflow', model: 'Qwen/Qwen3-8B' });

  // parse edge cases
  assert.strictEqual(mm.parseAgentDefaultModel('theme: dark\n'), null);
  assert.strictEqual(mm.parseAgentDefaultModel('agent-default-model:\n  provider: "x"\n'), null); // no model
  assert.strictEqual(mm.parseAgentDefaultModel(''), null);

  // removeSection drops the whole section only
  const afterRm = mm.removeSection(after, 'agent-default-model');
  assert.ok(!afterRm.includes('agent-default-model'));
  assert.ok(afterRm.includes('theme: dark'));
  assert.ok(afterRm.includes('channels: {}'));
});

test('upsertProviderRoute: creates the llm-pi-ai chain, keeps siblings, replaces one route, collapses to {} when emptied', () => {
  const base = [
    '# dsh settings',
    'theme: dark',
    'channels: {}',
  ].join('\n');
  const profile = (name, models) => ({ name, apiKeyRef: 'SILICONFLOW_API_KEY', baseURL: 'https://api.siliconflow.cn/v1', models });

  // 1) creates section chain on a file that has none
  let y = mm.upsertProviderRoute(base, 'siliconflow', profile('SiliconFlow', ['Qwen/Qwen3-8B']));
  assert.ok(y.includes('llm-pi-ai:'));
  assert.ok(y.includes('  providers:'));
  assert.ok(y.includes('    siliconflow:'));
  assert.ok(y.includes('      apiKeyEnv: SILICONFLOW_API_KEY'));
  assert.ok(y.includes('      api: openai-completions'));
  assert.ok(y.includes('        - id: "Qwen/Qwen3-8B"'));
  assert.ok(y.includes('theme: dark') && y.includes('channels: {}'));

  // 2) second route: the sibling survives verbatim
  const moon = { name: 'Moonshot', apiKeyRef: 'MOONSHOT_API_KEY', baseURL: 'https://api.moonshot.cn/v1', models: ['kimi-latest'] };
  y = mm.upsertProviderRoute(y, 'moonshot', moon);
  assert.ok(y.includes('    siliconflow:'));
  assert.ok(y.indexOf('    siliconflow:') < y.indexOf('    moonshot:'));

  // 3) update-in-place replaces only that route's block
  y = mm.upsertProviderRoute(y, 'siliconflow', profile('SiliconFlow Pro', ['Qwen/Qwen3-14B']));
  assert.ok(y.includes('displayName: "SiliconFlow Pro"'));
  assert.ok(!y.includes('Qwen/Qwen3-8B'), 'stale model id must be replaced, not appended');
  assert.ok(y.includes('- id: "kimi-latest"'), 'sibling route untouched');

  // 4) remove keeps the other route; removing the last one collapses providers to {}
  y = mm.removeProviderRoute(y, 'moonshot');
  assert.ok(!y.includes('moonshot:'));
  assert.ok(y.includes('siliconflow:'));
  y = mm.removeProviderRoute(y, 'siliconflow');
  assert.ok(y.includes('  providers: {}'), 'emptied providers map collapses to {}');
  assert.ok(!y.includes('openai-completions'));
  // idempotent on absent routes/sections
  assert.strictEqual(mm.removeProviderRoute(y, 'nope'), y);
  assert.strictEqual(mm.removeProviderRoute('theme: dark\n', 'x'), 'theme: dark\n');
});

// ------------------------------------------------------- transport & classify

test('classifyFailure maps statuses and transport errors onto panel error classes', () => {
  assert.strictEqual(mm.classifyFailure(401, null), 'invalid-key');
  assert.strictEqual(mm.classifyFailure(403, null), 'invalid-key');
  assert.strictEqual(mm.classifyFailure(402, null), 'quota');
  assert.strictEqual(mm.classifyFailure(429, null), 'quota');
  assert.strictEqual(mm.classifyFailure(404, null), 'endpoint');
  assert.strictEqual(mm.classifyFailure(502, null), 'server');
  assert.strictEqual(mm.classifyFailure(null, Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), 'network');
  assert.strictEqual(mm.classifyFailure(null, Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), 'network');
  assert.strictEqual(mm.classifyFailure(null, new Error('request timeout')), 'network');
  assert.strictEqual(mm.classifyFailure(418, null), 'other');
});

test('testConnection: ok parses/dedupes/sorts models; failures classify; parseModelsPayload rejects junk', async () => {
  const okBody = JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, { id: 'a' }, { junk: 1 }, null] });
  const stub = async (url, opts) => {
    assert.match(url, /\/models$/, 'must GET {baseURL}/models');
    assert.match(opts.headers.Authorization, /^Bearer sk-/);
    if (url.startsWith('https://bad-key')) return { status: 401, body: '' };
    if (url.startsWith('https://quota')) return { status: 429, body: '' };
    if (url.startsWith('https://odd')) return { status: 200, body: '<html>no</html>' };
    if (url.startsWith('https://down')) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    return { status: 200, body: okBody };
  };
  const base = { baseURL: 'https://api.test/v1/', apiKey: 'sk-1', fetchImpl: stub };

  const ok = await mm.testConnection(base);
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.models, ['a', 'b']); // deduped + sorted

  const bad = await mm.testConnection({ ...base, baseURL: 'https://bad-key/v1' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.kind, 'invalid-key');
  assert.strictEqual(bad.status, 401);
  assert.strictEqual((await mm.testConnection({ ...base, baseURL: 'https://quota/v1' })).kind, 'quota');
  assert.strictEqual((await mm.testConnection({ ...base, baseURL: 'https://odd/v1' })).kind, 'endpoint');
  assert.strictEqual((await mm.testConnection({ ...base, baseURL: 'https://down/v1' })).kind, 'network');
  assert.strictEqual((await mm.testConnection({ ...base, apiKey: '' })).kind, 'no-key');
  assert.strictEqual((await mm.testConnection({ ...base, baseURL: 'ftp://x' })).kind, 'endpoint');

  assert.strictEqual(mm.parseModelsPayload('not json'), null);
  assert.strictEqual(mm.parseModelsPayload({ data: 'x' }), null);
});

test('detectOllama: version+tags reduce to installed; refusal reduces to not-installed; tags failure tolerated', async () => {
  const up = async (url) => {
    if (url.endsWith('/api/version')) return { status: 200, body: JSON.stringify({ version: '0.12.6' }) };
    if (url.endsWith('/api/tags')) {
      return { status: 200, body: JSON.stringify({ models: [{ name: 'llama3.2' }, { name: 'qwen3:8b' }, { malformed: 1 }] }) };
    }
    throw new Error('unexpected ' + url);
  };
  const st = await mm.detectOllama({ fetchImpl: up });
  assert.strictEqual(st.installed, true);
  assert.strictEqual(st.version, '0.12.6');
  assert.deepStrictEqual(st.models, ['llama3.2', 'qwen3:8b']);

  const down = async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }); };
  const st2 = await mm.detectOllama({ fetchImpl: down });
  assert.strictEqual(st2.installed, false);
  assert.strictEqual(st2.version, null);
  assert.deepStrictEqual(st2.models, []);
  assert.ok(st2.reason);

  const noTags = async (url) => {
    if (url.endsWith('/api/version')) return { status: 200, body: JSON.stringify({ version: '1.0' }) };
    throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  };
  const st3 = await mm.detectOllama({ fetchImpl: noTags });
  assert.strictEqual(st3.installed, true, 'liveness alone counts as installed');
  assert.deepStrictEqual(st3.models, []);
});

// ------------------------------------------------------------------- KeyVault

test('KeyVault: safeStorage round trip persists across instances; plain fallback is clearly marked; remove deletes', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'model-keys.json');
  const fake = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (b) => {
      const s = b.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('not mine');
      return s.slice(4);
    },
  };
  const v1 = new mm.KeyVault(file, fake);
  v1.set('siliconflow', 'sk-secret');
  assert.strictEqual(v1.get('siliconflow'), 'sk-secret');
  // persisted ciphertext must not contain the plaintext
  assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-secret'));
  // fresh instance reads the same master copy back
  const v2 = new mm.KeyVault(file, fake);
  assert.strictEqual(v2.get('siliconflow'), 'sk-secret');
  v2.remove('siliconflow');
  assert.strictEqual(v2.get('siliconflow'), null);
  assert.strictEqual(new mm.KeyVault(file, fake).get('siliconflow'), null);

  // without safeStorage: degrades to a marked, non-silent encoding
  const plain = new mm.KeyVault(path.join(dir, 'plain.json'), null);
  plain.set('moonshot', 'sk-plain');
  assert.strictEqual(plain.get('moonshot'), 'sk-plain');
  const raw = fs.readFileSync(path.join(dir, 'plain.json'), 'utf8');
  assert.ok(raw.includes('cGxhaW46'), 'plain fallback is base64("plain:…") — obfuscated, never silent plaintext');
});

test('KeyVault: vault file is 0600 (like .credentials.yaml); a legacy 0644 file is tightened on load', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'model-keys.json');
  new mm.KeyVault(file, null).set('siliconflow', 'sk-x');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'key vault must be 0600 on POSIX');

  // legacy wide-perm file: the successful read path tightens it (best effort)
  const legacy = path.join(dir, 'legacy-keys.json');
  fs.writeFileSync(legacy, JSON.stringify({ siliconflow: Buffer.from('plain:sk-y').toString('base64') }));
  fs.chmodSync(legacy, 0o644); // defeat umask: simulate a pre-0600 install
  const reloaded = new mm.KeyVault(legacy, null);
  assert.strictEqual(reloaded.get('siliconflow'), 'sk-y', 'legacy vault still decodes');
  assert.strictEqual(fs.statSync(legacy).mode & 0o777, 0o600, 'legacy vault tightened on read');
});

// ------------------------------------------------------- manager end-to-end

test('createModelsManager: save/list/setDefault/remove run the full chain on a temp DSH_HOME', async () => {
  const dir = tmpDir();
  const dshHome = path.join(dir, 'dsh');
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(path.join(dshHome, 'settings.yaml'), '# dsh settings\ntheme: dark\n');
  fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), '# creds\nDEEPSEEK_API_KEY: sk-deep\n');

  const store = { modelProviders: [] };
  const settings = { get: () => store, patch: (p) => Object.assign(store, p) };
  const mgr = mm.createModelsManager({
    settings,
    dshHome: () => dshHome,
    userDataDir: path.join(dir, 'userdata'),
    safeStorage: null,
    log: () => {},
    fetchImpl: async () => ({ status: 200, body: JSON.stringify({ data: [{ id: 'm2' }, { id: 'm1' }] }) }),
  });

  // save: settings store + vault + .credentials.yaml + settings.yaml route
  const r = mgr.save({
    id: 'siliconflow', preset: 'siliconflow', name: 'SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1', models: ['Qwen/Qwen3-8B'],
  }, 'sk-live-42');
  assert.strictEqual(r.ok, true);
  const creds = fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8');
  assert.ok(creds.includes('DEEPSEEK_API_KEY: sk-deep'), 'foreign credential preserved');
  assert.ok(creds.includes('SILICONFLOW_API_KEY: sk-live-42'));
  const y = fs.readFileSync(path.join(dshHome, 'settings.yaml'), 'utf8');
  assert.ok(y.includes('llm-pi-ai:') && y.includes('theme: dark'), 'settings.yaml keeps foreign keys');
  assert.ok(y.includes('baseURL: "https://api.siliconflow.cn/v1"'));

  // list: no key material crosses over, but keyConfigured is true
  const snap = mgr.list();
  assert.strictEqual(snap.profiles.length, 1);
  assert.strictEqual(snap.profiles[0].keyConfigured, true);
  assert.ok(!JSON.stringify(snap).includes('sk-live-42'), 'key must never appear in the renderer snapshot');

  // re-save without a fresh key keeps the stored one
  mgr.save({ id: 'siliconflow', preset: 'siliconflow', name: 'SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', models: ['Qwen/Qwen3-8B', 'Qwen/Qwen3-14B'] });
  assert.ok(fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8').includes('SILICONFLOW_API_KEY: sk-live-42'));

  // test() resolves the stored key main-side (fetch stub sees the bearer)
  const seen = [];
  const mgr2 = mm.createModelsManager({
    settings, dshHome: () => dshHome, userDataDir: path.join(dir, 'userdata2'),
    safeStorage: null, log: () => {},
    fetchImpl: async (u, o) => { seen.push(o.headers.Authorization); return { status: 200, body: JSON.stringify({ data: [{ id: 'm' }] }) }; },
  });
  const tres = await mgr2.test({ profileId: 'siliconflow' });
  assert.strictEqual(tres.ok, true);
  assert.deepStrictEqual(seen, ['Bearer sk-live-42']);

  // setDefault/getDefault round trip through settings.yaml
  assert.strictEqual(mgr.getDefault(), null);
  assert.strictEqual(mgr.setDefault('siliconflow', 'Qwen/Qwen3-8B').ok, true);
  assert.deepStrictEqual(mgr.getDefault(), { provider: 'siliconflow', model: 'Qwen/Qwen3-8B' });

  // ollamaStatus reduces probe + registration flag
  const oSt = await mgr.ollamaStatus();
  assert.strictEqual(typeof oSt.installed, 'boolean');
  assert.strictEqual(oSt.registered, false);

  // remove clears every trace, incl. the default that pointed at it
  assert.strictEqual(mgr.remove('siliconflow').ok, true);
  const creds2 = fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8');
  const y2 = fs.readFileSync(path.join(dshHome, 'settings.yaml'), 'utf8');
  assert.ok(!creds2.includes('SILICONFLOW_API_KEY'));
  assert.ok(creds2.includes('DEEPSEEK_API_KEY: sk-deep'));
  assert.ok(!y2.includes('siliconflow'));
  assert.ok(!y2.includes('agent-default-model'), 'default pointing at the removed provider is dropped');
  assert.ok(y2.includes('theme: dark'));
  assert.deepStrictEqual(mgr.list().profiles, []);
  assert.strictEqual(mgr.remove('siliconflow').ok, false, 'removing an absent profile fails politely');

  // saveOllama registers with the fixed placeholder key
  const oR = mgr.saveOllama(['llama3.2']);
  assert.strictEqual(oR.ok, true);
  assert.strictEqual(mm.readCredential(fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8'), 'OLLAMA_API_KEY'), 'ollama');
  assert.strictEqual((await mgr.ollamaStatus()).registered, true);
  assert.strictEqual(mgr.saveOllama([]).ok, false, 'needs ≥1 model');

  // custom-id credential ref derivation: my-gateway → MY_GATEWAY_API_KEY
  assert.strictEqual(mm.refFromRoute('my-gateway'), 'MY_GATEWAY_API_KEY');
  // sanitize rejects bad shapes without writing anything
  const beforeY = fs.readFileSync(path.join(dshHome, 'settings.yaml'), 'utf8');
  assert.strictEqual(mgr.save({ id: 'Bad Id', name: 'x', baseURL: 'https://x/v1', models: ['m'] }).ok, false);
  assert.strictEqual(mgr.save({ id: 'ok-id', name: 'x', baseURL: 'notaurl', models: ['m'] }).ok, false);
  assert.strictEqual(mgr.save({ id: 'ok-id', name: 'x', baseURL: 'https://x/v1', models: [] }).ok, false);
  assert.strictEqual(fs.readFileSync(path.join(dshHome, 'settings.yaml'), 'utf8'), beforeY);
});
