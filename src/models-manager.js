// src/models-manager.js — model provider panel + Ollama (C2, v0.2.4).
//
// Third-party provider profiles (6 presets + custom + Ollama) with connection
// testing, model-list fetching and default-model switching. Pure logic (YAML
// line-level patching / error classification / presets) lives in plain
// functions so tests run under plain node; `createModelsManager()` wires them
// into one stateful object for the main process.
//
// Provider registration path (code-verified against the shipped runtime
// 0.1.0-rc.6): the dsh `llm-pi-ai` adapter declares arbitrary provider routes
// through the `llm-pi-ai` settings namespace in $DSH_HOME/settings.yaml —
// "a route pi-ai does not ship is declared outright … configuration rather
// than a code change" (@deepseek-ai/dsh-llm-pi-ai/lib/index.js, Config schema).
// So a profile becomes:
//
//   llm-pi-ai:
//     providers:
//       siliconflow:
//         displayName: "SiliconFlow"
//         apiKeyEnv: SILICONFLOW_API_KEY     # credential *ref*, never a value
//         api: openai-completions
//         baseURL: "https://api.siliconflow.cn/v1"
//         models:
//           - id: "Qwen/Qwen3-8B"
//
// Key three-stage chain (RESEARCH-0.2.4-MODELS.md §6.3):
//   user input → safeStorage-encrypted master copy (this shell, userData)
//             → plaintext sync write $DSH_HOME/.credentials.yaml (0600,
//                atomic, other keys preserved — the runtime reads THIS file;
//                chokidar hot-reload, no restart)
//   backups exclude .credentials.yaml already (backup.js whitelist).
// The key never crosses to the renderer: test/fetch run here in the main
// process and only the result shape goes back over IPC.
//
// settings.yaml / .credentials.yaml edits are conservative line-level section
// patches (no YAML dependency): other namespaces, their order and comments
// survive; the runtime's own FileSettingsProvider patches the same file the
// same way (one namespace at a time), so both writers coexist.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const TEST_TIMEOUT_MS = 8_000;   // GET {baseURL}/models
const OLLAMA_TIMEOUT_MS = 2_000; // /api/version + /api/tags probes
const OLLAMA_BASE = 'http://localhost:11434/v1';
const OLLAMA_KEY = 'ollama'; // required-but-ignored by Ollama's OpenAI layer

/** Builtin preset templates (RESEARCH-0.2.4-MODELS.md §5; checked 2026-08).
 * `id` doubles as the runtime provider route; `keyEnv` is the credential
 * reference written to .credentials.yaml and llm-pi-ai's apiKeyEnv. */
const PRESETS = [
  {
    id: 'siliconflow', nameKey: 'models_preset_siliconflow',
    baseURL: 'https://api.siliconflow.cn/v1', keyEnv: 'SILICONFLOW_API_KEY',
    portalUrl: 'https://cloud.siliconflow.cn/account/ak', docsUrl: 'https://cloud.siliconflow.cn/',
  },
  {
    id: 'moonshot', nameKey: 'models_preset_moonshot',
    baseURL: 'https://api.moonshot.cn/v1', keyEnv: 'MOONSHOT_API_KEY',
    portalUrl: 'https://platform.moonshot.cn/console/api-keys', docsUrl: 'https://platform.moonshot.cn/',
  },
  {
    id: 'zhipu-glm', nameKey: 'models_preset_zhipu',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'ZHIPU_API_KEY',
    portalUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', docsUrl: 'https://bigmodel.cn/',
  },
  {
    id: 'dashscope', nameKey: 'models_preset_dashscope',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyEnv: 'DASHSCOPE_API_KEY',
    portalUrl: 'https://bailian.console.aliyun.com/', docsUrl: 'https://help.aliyun.com/zh/model-studio/',
    noteKey: 'models_note_dashscope',
  },
  {
    id: 'volcengine-ark', nameKey: 'models_preset_volcark',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3', keyEnv: 'ARK_API_KEY',
    portalUrl: 'https://console.volcengine.com/ark', docsUrl: 'https://www.volcengine.com/docs/82379/',
    noteKey: 'models_note_volcark',
  },
  {
    id: 'openrouter', nameKey: 'models_preset_openrouter',
    baseURL: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY',
    portalUrl: 'https://openrouter.ai/settings/keys', docsUrl: 'https://openrouter.ai/docs',
  },
  { id: 'custom', nameKey: 'models_preset_custom', baseURL: '', keyEnv: '' },
];

/** Ollama is registered through the same route mechanism with a fixed key. */
const OLLAMA_PRESET = {
  id: 'ollama', nameKey: 'models_preset_ollama',
  baseURL: OLLAMA_BASE, keyEnv: 'OLLAMA_API_KEY', ollama: true,
};

const ROUTE_ID_RE = /^[a-z][a-z0-9-]*$/;        // runtime customRoute rule
const CREDENTIAL_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/; // runtime credentialRef rule

// ------------------------------------------------------------- yaml helpers

/** A double-quoted JSON scalar — valid YAML 1.2, safe for any id/name. */
function yamlScalar(v) {
  return JSON.stringify(String(v));
}

/** Index of the line opening a top-level `key:` section, or -1. */
function topKeyLine(lines, key) {
  const re = new RegExp(`^${key}:\\s*(#.*)?$`);
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i;
  return -1;
}

/** First line at index >= from that opens another top-level key section. */
function nextTopKey(lines, from) {
  for (let i = from; i < lines.length; i++) if (/^[A-Za-z][\w.-]*:/.test(lines[i])) return i;
  return lines.length;
}

/** Replace/append one top-level section; bodyLines are pre-indented YAML. */
function upsertSection(text, key, bodyLines) {
  const lines = text.split('\n');
  const at = topKeyLine(lines, key);
  if (at === -1) {
    const out = [...lines];
    if (out.length && out[out.length - 1] !== '') out.push('');
    out.push(`${key}:`, ...bodyLines);
    return out.join('\n');
  }
  const end = nextTopKey(lines, at + 1);
  lines.splice(at + 1, end - (at + 1), ...bodyLines);
  return lines.join('\n');
}

/** Drop one top-level section entirely (noop when absent). */
function removeSection(text, key) {
  const lines = text.split('\n');
  const at = topKeyLine(lines, key);
  if (at === -1) return text;
  const end = nextTopKey(lines, at + 1);
  lines.splice(at, end - at);
  return lines.join('\n');
}

/** Read `  provider:` / `  model:` (plain or quoted) out of a section. */
function sectionScalar(lines, start, key) {
  const end = nextTopKey(lines, start + 1);
  const re = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*(#.*)?$`);
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(re);
    if (m) {
      let v = m[1].trim();
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
        try { v = JSON.parse(v); } catch { /* keep raw */ }
      }
      return v;
    }
  }
  return null;
}

/** Current {provider, model} from settings.yaml's agent-default-model, or null. */
function parseAgentDefaultModel(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const at = topKeyLine(lines, 'agent-default-model');
  if (at === -1) return null;
  const provider = sectionScalar(lines, at, 'provider');
  const model = sectionScalar(lines, at, 'model');
  if (!provider || !model) return null;
  return { provider, model };
}

/** Render the agent-default-model section body (runtime schema: provider +
 * model required, reasoningEffort optional and omitted when falsy). */
function agentDefaultModelBody({ provider, model, reasoningEffort }) {
  const body = [
    `  provider: ${yamlScalar(provider)}`,
    `  model: ${yamlScalar(model)}`,
  ];
  if (reasoningEffort) body.push(`  reasoningEffort: ${yamlScalar(reasoningEffort)}`);
  return body;
}

/** Build the YAML block for one provider route (4-space indent under
 * llm-pi-ai → providers). Field order mirrors the adapter README example. */
function providerRouteBlock(route, { name, apiKeyRef, baseURL, models }) {
  return [
    `    ${route}:`,
    `      displayName: ${yamlScalar(name)}`,
    `      apiKeyEnv: ${apiKeyRef}`,
    '      api: openai-completions',
    `      baseURL: ${yamlScalar(baseURL)}`,
    '      models:',
    ...models.map((m) => `        - id: ${yamlScalar(m)}`),
  ];
}

/**
 * Upsert one provider route under `llm-pi-ai.providers` with line-level
 * surgery: sibling routes, other namespaces, blank lines and comments all
 * keep their positions. Creates the section chain when missing.
 */
function upsertProviderRoute(text, route, profile) {
  const block = providerRouteBlock(route, profile);
  const lines = text.split('\n');
  const secAt = topKeyLine(lines, 'llm-pi-ai');
  if (secAt === -1) {
    const out = [...lines];
    if (out.length && out[out.length - 1] !== '') out.push('');
    out.push('llm-pi-ai:', '  providers:', ...block);
    return out.join('\n');
  }
  const secEnd = nextTopKey(lines, secAt + 1);
  // locate `  providers:` (exactly two spaces) anywhere inside the section
  let provAt = -1;
  for (let i = secAt + 1; i < secEnd; i++) {
    if (/^  providers:\s*(#.*)?$/.test(lines[i])) { provAt = i; break; }
  }
  if (provAt === -1) {
    lines.splice(secAt + 1, 0, '  providers:', ...block);
    return lines.join('\n');
  }
  // providers block ends at the first line indented less than 4 spaces
  let provEnd = secEnd;
  for (let i = provAt + 1; i < secEnd; i++) {
    if (!/^    |\s*$/.test(lines[i])) { provEnd = i; break; }
  }
  // find the route's existing block (exactly 4 spaces + "route:")
  const routeRe = new RegExp(`^    ${route}:\\s*(#.*)?$`);
  let routeAt = -1;
  for (let i = provAt + 1; i < provEnd; i++) {
    if (routeRe.test(lines[i])) { routeAt = i; break; }
  }
  if (routeAt !== -1) {
    let routeEnd = provEnd;
    for (let i = routeAt + 1; i < provEnd; i++) {
      if (/^    \S/.test(lines[i]) || !/^      |\s*$/.test(lines[i])) { routeEnd = i; break; }
    }
    lines.splice(routeAt, routeEnd - routeAt, ...block);
    return lines.join('\n');
  }
  lines.splice(provEnd, 0, ...block);
  return lines.join('\n');
}

/** Remove one provider route; collapses an emptied providers map to `{}`. */
function removeProviderRoute(text, route) {
  const lines = text.split('\n');
  const secAt = topKeyLine(lines, 'llm-pi-ai');
  if (secAt === -1) return text;
  const secEnd = nextTopKey(lines, secAt + 1);
  let provAt = -1;
  for (let i = secAt + 1; i < secEnd; i++) {
    if (/^  providers:\s*(#.*)?$/.test(lines[i])) { provAt = i; break; }
  }
  if (provAt === -1) return text;
  let provEnd = secEnd;
  for (let i = provAt + 1; i < secEnd; i++) {
    if (!/^    |\s*$/.test(lines[i])) { provEnd = i; break; }
  }
  const routeRe = new RegExp(`^    ${route}:\\s*(#.*)?$`);
  for (let i = provAt + 1; i < provEnd; i++) {
    if (routeRe.test(lines[i])) {
      let routeEnd = provEnd;
      for (let j = i + 1; j < provEnd; j++) {
        if (/^    \S/.test(lines[j]) || !/^      |\s*$/.test(lines[j])) { routeEnd = j; break; }
      }
      lines.splice(i, routeEnd - i);
      // providers left with no route entries?
      let still = false;
      for (let j = provAt + 1; j < secEnd; j++) {
        if (/^    \S/.test(lines[j])) { still = true; break; }
      }
      if (!still) lines[provAt] = '  providers: {}';
      return lines.join('\n');
    }
  }
  return text;
}

// ------------------------------------------------------ credentials helpers

/** Value of one `REF: value` line (quotes stripped), or null. */
function readCredential(text, ref) {
  if (!text) return null;
  const m = text.match(new RegExp(`^\\s*${ref}\\s*:\\s*(\\S+)\\s*$`, 'm'));
  if (!m) return null;
  return m[1].replace(/^['"]|['"]$/g, '');
}

/** Upsert one `REF: value` line; every other line (keys, comments, blanks)
 * keeps its exact position. */
function upsertCredential(text, ref, value) {
  const line = `${ref}: ${value}`;
  const re = new RegExp(`^\\s*${ref}\\s*:.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  const t = text || '';
  if (!t) return `${line}\n`;
  return t.endsWith('\n') ? `${t}${line}\n` : `${t}\n${line}\n`;
}

/** Drop one `REF:` line (noop when absent). */
function removeCredential(text, ref) {
  if (!text) return text;
  return text
    .split('\n')
    .filter((l) => !new RegExp(`^\\s*${ref}\\s*:`).test(l))
    .join('\n');
}

/** Atomic write with mandatory 0600 (the runtime refuses group/other-readable
 * credentials files on POSIX). Best effort on platforms without chmod. */
function writeCredentialsFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* win: no-op */ }
  fs.renameSync(tmp, file);
}

/** Atomic write for settings.yaml (no mode constraint). */
function writeSettingsFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const readText = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
};

// -------------------------------------------------------- transport layer

/** GET a URL, resolve {status, body} (follows up to 3 redirects), reject with
 * an Error carrying .code for classification. Agent-less: no keep-alive pins. */
function httpGetJson(url, { headers, timeoutMs } = {}) {
  const timeout = timeoutMs || TEST_TIMEOUT_MS;
  const attempt = (u, depth) => new Promise((resolve, reject) => {
    let target;
    try { target = new URL(u); } catch { reject(new Error('invalid URL')); return; }
    const mod = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
    if (!mod) { reject(new Error('unsupported protocol')); return; }
    const req = mod.get(target, { headers, timeout, agent: false }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc && depth < 3) {
        res.resume(); // drain
        try { resolve(attempt(new URL(loc, target).toString(), depth + 1)); return; } catch { /* fall through */ }
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => reject(e));
  });
  return attempt(url, 0);
}

/** Map an HTTP status / transport error onto the panel's error classes. */
function classifyFailure(status, err) {
  if (status === 401 || status === 403) return 'invalid-key';
  if (status === 402 || status === 429) return 'quota';
  if (status === 404) return 'endpoint';
  if (err) {
    const code = err.code || '';
    if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'network';
    if (/timeout/i.test(err.message || '')) return 'network';
  }
  if (status >= 500) return 'server';
  return 'other';
}

/** Parse an OpenAI-compatible GET /models payload into sorted ids. */
function parseModelsPayload(body) {
  let res = body;
  if (typeof body === 'string') {
    try { res = JSON.parse(body); } catch { return null; }
  }
  if (!res || !Array.isArray(res.data)) return null;
  const ids = res.data
    .map((m) => m && typeof m === 'object' && typeof m.id === 'string' ? m.id : null)
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

/**
 * L1 connection test: GET {baseURL}/models with a Bearer key (8s timeout).
 * Resolves {ok, kind, status?, models?, reason?}; the key is never part of
 * the result. `kind` is one of ok | invalid-key | quota | endpoint |
 * network | server | no-key | other.
 */
async function testConnection({ baseURL, apiKey, fetchImpl, timeoutMs }) {
  if (!apiKey) return { ok: false, kind: 'no-key', reason: 'missing API key' };
  const base = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(base)) return { ok: false, kind: 'endpoint', reason: 'invalid baseURL' };
  const fetchFn = fetchImpl || ((u, opts) => httpGetJson(u, opts));
  try {
    const { status, body } = await fetchFn(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeoutMs: timeoutMs || TEST_TIMEOUT_MS,
    });
    if (status !== 200) {
      return { ok: false, kind: classifyFailure(status), status, reason: `HTTP ${status}` };
    }
    const models = parseModelsPayload(body);
    if (!models) return { ok: false, kind: 'endpoint', status, reason: 'unexpected payload (not an OpenAI-compatible /models response)' };
    return { ok: true, kind: 'ok', status, models };
  } catch (e) {
    return { ok: false, kind: classifyFailure(null, e), reason: e.message };
  }
}

/**
 * Ollama local probe: /api/version (liveness + version) then /api/tags
 * (installed models). 2s timeouts; connection refused simply means "not
 * installed / not running" — never an error state for the UI.
 */
async function detectOllama({ host, port, fetchImpl, timeoutMs } = {}) {
  const h = host || '127.0.0.1';
  const p = port || 11434;
  const fetchFn = fetchImpl || ((u, opts) => httpGetJson(u, opts));
  const t = timeoutMs || OLLAMA_TIMEOUT_MS;
  try {
    const { body } = await fetchFn(`http://${h}:${p}/api/version`, { timeoutMs: t });
    let version = null;
    try { version = JSON.parse(body).version || null; } catch { /* keep null */ }
    let models = [];
    try {
      const tags = await fetchFn(`http://${h}:${p}/api/tags`, { timeoutMs: t });
      const parsed = JSON.parse(tags.body);
      if (parsed && Array.isArray(parsed.models)) {
        models = parsed.models.map((m) => m && m.name).filter(Boolean).sort();
      }
    } catch { /* tags optional for the status line */ }
    return { installed: true, version, models, reason: null };
  } catch (e) {
    return { installed: false, version: null, models: [], reason: e.code || e.message };
  }
}

// --------------------------------------------------------------- key vault

/**
 * safeStorage-encrypted master copies of provider API keys, one JSON file
 * under userData: { routeId: base64(ciphertext) }. Mirrors remote-control's
 * TokenStore fallback: without safeStorage the value degrades to a clearly
 * marked base64 blob ('plain:' prefix) and a log warning — never a silent
 * plaintext file.
 */
class KeyVault {
  constructor(file, safeStorage, log) {
    this.file = file;
    this.safeStorage = safeStorage || null;
    this.log = log || (() => {});
    this.warned = false;
    this.map = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(raw || {})) this.map.set(k, Buffer.from(String(v), 'base64'));
      // legacy file written before the 0600 rule: tighten on the read path
      // (best effort — never block the vault on a chmod failure)
      try { fs.chmodSync(file, 0o600); } catch { /* win: no-op */ }
    } catch { /* first run */ }
  }

  usable() {
    try {
      return !!this.safeStorage && typeof this.safeStorage.encryptString === 'function'
        && typeof this.safeStorage.decryptString === 'function'
        && (typeof this.safeStorage.isEncryptionAvailable !== 'function' || this.safeStorage.isEncryptionAvailable());
    } catch { return false; }
  }

  encode(plain) {
    if (this.usable()) return this.safeStorage.encryptString(plain);
    if (!this.warned) {
      this.warned = true;
      this.log('[models] safeStorage unavailable; provider keys stored base64-obfuscated only');
    }
    return Buffer.concat([Buffer.from('plain:', 'utf8'), Buffer.from(plain, 'utf8')]);
  }

  decode(buf) {
    try {
      const s = buf.toString('utf8');
      if (s.startsWith('plain:')) return s.slice(6);
      if (this.safeStorage && typeof this.safeStorage.decryptString === 'function') {
        return this.safeStorage.decryptString(buf);
      }
    } catch { /* fall through */ }
    return null;
  }

  persist() {
    const out = {};
    for (const [k, v] of this.map) out[k] = v.toString('base64');
    // 0600 atomic write like .credentials.yaml: without safeStorage this file
    // holds the provider keys in a merely base64-obfuscated form.
    writeCredentialsFile(this.file, JSON.stringify(out, null, 2));
  }

  set(id, plain) {
    this.map.set(id, this.encode(String(plain)));
    this.persist();
  }

  get(id) {
    const buf = this.map.get(id);
    return buf ? this.decode(buf) : null;
  }

  has(id) { return this.map.has(id); }

  remove(id) {
    if (!this.map.delete(id)) return;
    this.persist();
  }
}

// ----------------------------------------------------------------- manager

/** Derive a credential ref from a custom route id: my-gateway → MY_GATEWAY_API_KEY. */
function refFromRoute(route) {
  return `${route.toUpperCase().replaceAll('-', '_')}_API_KEY`;
}

/**
 * Stateful manager for the main process. deps:
 *   - settings: SettingsStore (profiles persist in its modelProviders array)
 *   - dshHome(): string     — resolved $DSH_HOME
 *   - userDataDir: string   — key vault location
 *   - safeStorage           — electron safeStorage (nullable in tests)
 *   - log(line)             — shell log; never receives key material
 *   - fetchImpl(url, opts)  — transport override (tests)
 */
function createModelsManager(deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  const fetchImpl = d.fetchImpl || null;
  const vault = new KeyVault(path.join(d.userDataDir, 'model-keys.json'), d.safeStorage, log);
  const dshHome = () => d.dshHome();
  const credentialsFile = () => path.join(dshHome(), '.credentials.yaml');
  const settingsFile = () => path.join(dshHome(), 'settings.yaml');

  const profiles = () => d.settings.get().modelProviders || [];

  function sanitizeProfile(input, prev) {
    const preset = PRESETS.concat([OLLAMA_PRESET]).find((p) => p.id === input.preset) || null;
    let id = String(input.id || (preset && preset.id) || '').trim().toLowerCase();
    if (!id) return { err: 'missing id' };
    if (!ROUTE_ID_RE.test(id)) return { err: 'invalid route id (lowercase letter, then a-z0-9-)' };
    const name = String(input.name || (preset && preset.id) || '').trim().slice(0, 64);
    if (!name) return { err: 'missing name' };
    const baseURL = String(input.baseURL || (preset && preset.baseURL) || '').trim();
    if (!/^https?:\/\/.+/.test(baseURL)) return { err: 'invalid baseURL (must start with http:// or https://)' };
    let apiKeyRef = String(input.apiKeyRef || (preset && preset.keyEnv) || '').trim();
    if (!apiKeyRef) apiKeyRef = refFromRoute(id);
    if (!CREDENTIAL_REF_RE.test(apiKeyRef)) return { err: 'invalid credential ref (letters, digits, underscore)' };
    const models = [...new Set((Array.isArray(input.models) ? input.models : [])
      .map((m) => String(m || '').trim()).filter(Boolean))];
    if (!models.length) return { err: 'at least one model is required' };
    if (models.length > 200) models.length = 200;
    const profile = {
      id, name, baseURL, apiKeyRef, models,
      preset: preset && preset.id !== 'custom' ? preset.id : (prev && prev.preset) || null,
      ollama: !!(preset && preset.ollama) || !!(input.ollama) || !!(prev && prev.ollama),
      createdAt: (prev && prev.createdAt) || Date.now(),
    };
    return { profile };
  }

  return {
    PRESETS,
    OLLAMA_PRESET,

    /** Snapshot for the renderer: profiles (no key material — only a
     * configured flag), preset templates, and the current default model. */
    list() {
      return {
        presets: PRESETS,
        ollamaPreset: OLLAMA_PRESET,
        profiles: profiles().map((p) => ({
          id: p.id, name: p.name, baseURL: p.baseURL, apiKeyRef: p.apiKeyRef,
          models: p.models, preset: p.preset || null, ollama: !!p.ollama,
          keyConfigured: vault.has(p.id) || !!readCredential(readText(credentialsFile()), p.apiKeyRef),
        })),
        default: this.getDefault(),
      };
    },

    /**
     * Create/update one provider profile. When apiKey is provided (user just
     * typed it) the full three-stage chain runs; when omitted the stored key
     * is kept. Writes: shell settings.json, key vault, .credentials.yaml,
     * settings.yaml llm-pi-ai.providers.<id>.
     */
    save(input, apiKey) {
      const list = profiles();
      const prev = list.find((p) => p.id === (input && input.id));
      const { profile, err } = sanitizeProfile(input || {}, prev);
      if (err) return { ok: false, reason: err };
      const next = list.filter((p) => p.id !== profile.id);
      next.push(profile);
      d.settings.patch({ modelProviders: next });

      if (apiKey !== undefined && apiKey !== null && String(apiKey).length > 0) {
        vault.set(profile.id, String(apiKey));
        writeCredentialsFile(credentialsFile(), upsertCredential(readText(credentialsFile()), profile.apiKeyRef, String(apiKey)));
      }
      writeSettingsFile(settingsFile(), upsertProviderRoute(readText(settingsFile()), profile.id, profile));
      log(`[models] saved provider "${profile.id}" (${profile.models.length} models)`);
      return { ok: true, profile: { ...profile } };
    },

    /** Remove a profile and every trace of it (vault, credential line,
     * llm-pi-ai route; the default-model section too when it pointed here). */
    remove(id) {
      const list = profiles();
      const prev = list.find((p) => p.id === id);
      if (!prev) return { ok: false, reason: 'not found' };
      d.settings.patch({ modelProviders: list.filter((p) => p.id !== id) });
      vault.remove(id);
      writeCredentialsFile(credentialsFile(), removeCredential(readText(credentialsFile()), prev.apiKeyRef));
      writeSettingsFile(settingsFile(), removeProviderRoute(readText(settingsFile()), id));
      const def = this.getDefault();
      if (def && def.provider === id) {
        writeSettingsFile(settingsFile(), removeSection(readText(settingsFile()), 'agent-default-model'));
      }
      log(`[models] removed provider "${id}"`);
      return { ok: true };
    },

    /** Connection test (+ model fetch) entirely in the main process: the key
     * never crosses IPC back. `target` = {profileId} or {baseURL, apiKey?}. */
    async test(target) {
      const t = target || {};
      let baseURL = String(t.baseURL || '').trim();
      let apiKey = typeof t.apiKey === 'string' && t.apiKey ? t.apiKey : null;
      if (t.profileId) {
        const p = profiles().find((x) => x.id === t.profileId);
        if (p) {
          if (!baseURL) baseURL = p.baseURL;
          if (!apiKey) apiKey = vault.get(p.id)
            || readCredential(readText(credentialsFile()), p.apiKeyRef)
            || null;
        }
      }
      if (t.ollama && !apiKey) apiKey = OLLAMA_KEY; // ignored-but-required
      const res = await testConnection({ baseURL, apiKey, fetchImpl });
      if (res.ok) log(`[models] test ok: ${baseURL} (${res.models.length} models)`);
      else log(`[models] test failed: ${baseURL} kind=${res.kind} status=${res.status || '-'}`);
      return res;
    },

    /** Ollama probe + whether it is already registered as a provider. */
    async ollamaStatus() {
      const st = await detectOllama({ fetchImpl });
      st.registered = profiles().some((p) => p.ollama || p.id === 'ollama');
      return st;
    },

    /** Register Ollama as a provider route with a fixed placeholder key. */
    saveOllama(models) {
      const ids = [...new Set((Array.isArray(models) ? models : []).map((m) => String(m || '').trim()).filter(Boolean))];
      if (!ids.length) return { ok: false, reason: 'select at least one model' };
      return this.save({ id: 'ollama', preset: 'ollama', name: 'Ollama', baseURL: OLLAMA_BASE, models: ids, ollama: true }, OLLAMA_KEY);
    },

    /** Write settings.yaml's agent-default-model section (other keys kept). */
    setDefault(provider, model) {
      const p = String(provider || '').trim();
      const m = String(model || '').trim();
      if (!p || !m) return { ok: false, reason: 'provider and model are required' };
      writeSettingsFile(settingsFile(), upsertSection(readText(settingsFile()), 'agent-default-model', agentDefaultModelBody({ provider: p, model: m })));
      log(`[models] default model -> ${p} / ${m}`);
      return { ok: true, default: { provider: p, model: m } };
    },

    getDefault() {
      return parseAgentDefaultModel(readText(settingsFile()));
    },
  };
}

module.exports = {
  PRESETS,
  OLLAMA_PRESET,
  OLLAMA_BASE,
  OLLAMA_KEY,
  TEST_TIMEOUT_MS,
  OLLAMA_TIMEOUT_MS,
  yamlScalar,
  upsertSection,
  removeSection,
  upsertProviderRoute,
  removeProviderRoute,
  parseAgentDefaultModel,
  readCredential,
  upsertCredential,
  removeCredential,
  writeCredentialsFile,
  classifyFailure,
  parseModelsPayload,
  testConnection,
  detectOllama,
  KeyVault,
  refFromRoute,
  createModelsManager,
};
