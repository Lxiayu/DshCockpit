'use strict';

// studio/lib/providers.js — the provider registry and its ENFORCEMENT (brief §6).
//
// Three classes (llm / image / video), one rule that matters: a model id belongs to
// exactly one provider, and using it with another provider's key is refused BEFORE
// any request leaves the machine. Keys come from the environment or a local secrets
// file; they are never stored here, never logged, and never exported — errors carry
// a FINGERPRINT (first 4 chars + length + sha256 prefix), never the value.
//
// The policy this implements is written down in studio/docs/providers.md.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scan = require('./scan.js');

const KEY_MISSING = 'PROVIDER_KEY_MISSING';
const KEY_LEAK = 'PROVIDER_KEY_LEAK_SHAPE';
const MODEL_KEY_MISMATCH = 'PROVIDER_MODEL_KEY_MISMATCH';
const MODEL_UNKNOWN = 'PROVIDER_MODEL_UNKNOWN';

// The model-id prefix → provider table (docs/providers.md §2). Order matters only
// for readability; the match is a prefix test.
const MODEL_PREFIXES = Object.freeze([
  { prefix: 'gpt-', provider: 'hebox' },
  { prefix: 'o1', provider: 'hebox' },
  { prefix: 'o3', provider: 'hebox' },
  { prefix: 'qwen-', provider: 'dashscope' },
  { prefix: 'wan', provider: 'dashscope' },
  { prefix: 'minimax', provider: 'dashscope' },
  { prefix: 'gemini-', provider: 'tu-zi' },
  { prefix: 'claude-', provider: 'tu-zi' },
]);

const DEFAULT_REGISTRY = Object.freeze([
  {
    name: 'hebox', klass: 'image', baseURL: 'https://ai.hebox.net/v1',
    models: ['gpt-image-2'], keyRef: 'env:IMG_API_KEY',
    timeoutMs: 300000, retries: 1, costNote: 'per official site',
  },
  {
    name: 'dashscope', klass: 'image', baseURL: 'https://dashscope.aliyuncs.com/api/v1',
    models: ['qwen-image-edit'], keyRef: 'env:DASHSCOPE_API_KEY',
    timeoutMs: 300000, retries: 2, costNote: 'per official site',
  },
  {
    name: 'dashscope', klass: 'video', baseURL: 'https://dashscope.aliyuncs.com/api/v1',
    models: ['wan2.2-animate', 'minimax-h3'], keyRef: 'env:DASHSCOPE_API_KEY',
    timeoutMs: 900000, retries: 1, costNote: 'per official site',
  },
  {
    name: 'tu-zi', klass: 'llm', baseURL: null, models: ['gemini-3-pro'], keyRef: 'file:~/.dsh-secrets.env#TUZI_API_KEY',
    timeoutMs: 120000, retries: 2, costNote: 'per official site',
  },
]);

function providerOfModel(modelId, registry = DEFAULT_REGISTRY) {
  const explicit = registry.find((entry) => entry.models.includes(modelId));
  if (explicit) return explicit.name;
  const match = MODEL_PREFIXES.find((entry) => String(modelId).startsWith(entry.prefix));
  return match ? match.provider : null;
}

// env: NAME | file:~/path#KEY
function readKeyRef(keyRef, { env = process.env, readFile = (file) => fs.readFileSync(file, 'utf8') } = {}) {
  if (typeof keyRef !== 'string' || !keyRef) return { ok: false, code: KEY_MISSING, message: 'no key reference configured' };
  if (keyRef.startsWith('env:')) {
    const name = keyRef.slice('env:'.length);
    const value = env[name];
    if (!value) return { ok: false, code: KEY_MISSING, message: `environment variable ${name} is not set`, source: keyRef };
    return { ok: true, value, source: keyRef };
  }
  if (keyRef.startsWith('file:')) {
    const spec = keyRef.slice('file:'.length);
    const [filePart, varName] = spec.split('#');
    const file = filePart.startsWith('~/') ? path.join(os.homedir(), filePart.slice(2)) : filePart;
    if (!fs.existsSync(file)) return { ok: false, code: KEY_MISSING, message: `secrets file ${file} does not exist`, source: keyRef };
    const text = readFile(file);
    const match = new RegExp(`^\\s*(?:export\\s+)?${varName}\\s*=\\s*(.+)$`, 'm').exec(text);
    if (!match) return { ok: false, code: KEY_MISSING, message: `${varName} is not present in ${file}`, source: keyRef };
    return { ok: true, value: match[1].trim().replace(/^["']|["']$/g, ''), source: keyRef };
  }
  return { ok: false, code: KEY_MISSING, message: `unsupported key reference: ${keyRef}` };
}

// The gate every generation call passes through.
function resolveProvider({ model, klass = null, registry = DEFAULT_REGISTRY, env = process.env }) {
  const providerName = providerOfModel(model, registry);
  if (!providerName) return { ok: false, code: MODEL_UNKNOWN, message: `model ${JSON.stringify(model)} matches no known provider prefix (see docs/providers.md §2)` };
  const entry = registry.find((candidate) => candidate.name === providerName && candidate.models.includes(model))
    || registry.find((candidate) => candidate.name === providerName && (klass === null || candidate.klass === klass));
  if (!entry) return { ok: false, code: MODEL_KEY_MISMATCH, message: `provider ${providerName} has no ${klass || 'matching'} entry for model ${model}` };
  if (klass && entry.klass !== klass) {
    return { ok: false, code: MODEL_KEY_MISMATCH, message: `model ${model} is registered as ${entry.klass}, not ${klass}` };
  }
  const key = readKeyRef(entry.keyRef, { env });
  if (!key.ok) {
    return { ok: false, code: KEY_MISSING, message: key.message, provider: entry.name, model, keyRef: entry.keyRef };
  }
  // a key value must not itself look like a secret pattern in a report
  const scanOutcome = scan.scanForSecrets(key.value);
  return {
    ok: true,
    code: null,
    provider: entry.name,
    klass: entry.klass,
    model,
    baseURL: entry.baseURL,
    timeoutMs: entry.timeoutMs,
    retries: entry.retries,
    // the KEY VALUE never leaves this object; callers get a fingerprint
    keyFingerprint: scan.fingerprint(key.value),
    keySource: key.source,
    keyLeakShape: scanOutcome.ok ? null : scanOutcome.hits.map((hit) => hit.code),
  };
}

// Anything the studio is about to write or log goes through this: it refuses a
// payload that would carry a live key, so the leak cannot reach a file.
function assertNoKeyInPayload(text, keys, label) {
  for (const key of keys) {
    if (key && text.includes(key)) {
      const error = new Error(`${KEY_LEAK} ${label}: the payload contains a live key (${scan.fingerprint(key)})`);
      error.code = KEY_LEAK;
      throw error;
    }
  }
  const outcome = scan.scanForSecrets(text);
  if (!outcome.ok) {
    const error = new Error(`${KEY_LEAK} ${label}: secret-shaped strings found [${outcome.hits.map((hit) => hit.code).join(',')}]`);
    error.code = KEY_LEAK;
    error.hits = outcome.hits;
    throw error;
  }
  return true;
}

function describeRegistry(registry = DEFAULT_REGISTRY, env = process.env) {
  return registry.map((entry) => {
    const key = readKeyRef(entry.keyRef, { env });
    return {
      name: entry.name,
      klass: entry.klass,
      baseURL: entry.baseURL,
      models: entry.models,
      keyRef: entry.keyRef,
      keyStatus: key.ok ? 'present' : 'missing',
      keyFingerprint: key.ok ? scan.fingerprint(key.value) : null,
      timeoutMs: entry.timeoutMs,
      retries: entry.retries,
      costNote: entry.costNote,
    };
  });
}

module.exports = {
  DEFAULT_REGISTRY,
  KEY_LEAK,
  KEY_MISSING,
  MODEL_KEY_MISMATCH,
  MODEL_PREFIXES,
  MODEL_UNKNOWN,
  assertNoKeyInPayload,
  describeRegistry,
  providerOfModel,
  readKeyRef,
  resolveProvider,
};
